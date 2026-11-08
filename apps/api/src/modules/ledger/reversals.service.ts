import type { TransactionType } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { AppError } from "../../lib/errors";
import { audit } from "../../lib/audit";
import { isUniqueViolation } from "../../lib/dbErrors";
import { lockGroup } from "../../lib/locks";
import { formatRupees, paiseToNumber } from "../../lib/money";
import { groupFundBalance, postJournal } from "../../lib/ledger";
import { memberSavingsBalance } from "../../lib/ledgerAccounts";
import type { RequestMeta } from "../auth/auth.service";

// Loan and withdrawal journals have their own state machines (Phases 8 and 10),
// so they are corrected through those workflows, not here.
const REVERSIBLE = new Set<TransactionType>(["MONTHLY_DEPOSIT", "ADDITIONAL_DEPOSIT"]);

const conflict = (code: string, message: string) => new AppError(409, code, message);

export async function reverseTransaction(
  groupId: string,
  journalId: string,
  actor: { id: string; name: string },
  reason: string,
  meta: RequestMeta
) {
  try {
    return await prisma.$transaction(async (tx) => {
      // Serialises reversals (and anything else that locks the group).
      await lockGroup(tx, groupId);

      const original = await tx.ledgerJournal.findFirst({
        where: { id: journalId, groupId }, // groupId = tenant isolation
        include: { entries: true, paymentTransaction: true, reversal: { select: { id: true } } },
      });
      if (!original) throw new AppError(404, "TRANSACTION_NOT_FOUND", "Transaction not found.");
      if (original.type === "REVERSAL") {
        throw conflict("CANNOT_REVERSE_REVERSAL", "A reversal can't be reversed. Record a new deposit instead.");
      }
      if (original.reversal) throw conflict("ALREADY_REVERSED", "This transaction was already reversed.");
      if (!REVERSIBLE.has(original.type) || !original.paymentTransaction) {
        throw conflict(
          "NOT_REVERSIBLE",
          "Only deposits can be reversed here. Loans and withdrawals are corrected through their own workflows."
        );
      }

      const payment = original.paymentTransaction;
      const amount = original.entries
        .filter((e) => e.direction === "DEBIT")
        .reduce((sum, e) => sum + e.amountPaise, 0n);

      // The money must still be there to take back.
      const fund = await groupFundBalance(tx, groupId);
      if (fund < amount) {
        throw conflict(
          "INSUFFICIENT_FUND",
          `The group fund (${formatRupees(fund)}) can't cover reversing ${formatRupees(amount)}.`
        );
      }
      const savings = await memberSavingsBalance(tx, groupId, payment.userId);
      if (savings < amount) {
        throw conflict(
          "MEMBER_BALANCE_TOO_LOW",
          "This member's savings balance is lower than the deposit, so it can't be reversed."
        );
      }

      // A mirror image of the original: every debit becomes a credit and vice versa.
      const { journal, replayed } = await postJournal(tx, {
        groupId,
        type: "REVERSAL",
        description: `Reversal of ${original.type} ${original.id.slice(0, 8)}: ${reason}`,
        createdById: actor.id,
        approvedById: actor.id,
        paymentTransactionId: payment.id,
        reversalOfId: original.id,
        idempotencyKey: `reversal:${original.id}`,
        lines: original.entries.map((e) => ({
          accountId: e.accountId,
          direction: e.direction === "DEBIT" ? ("CREDIT" as const) : ("DEBIT" as const),
          amountPaise: e.amountPaise,
        })),
      });
      if (replayed) throw conflict("ALREADY_REVERSED", "This transaction was already reversed.");

      // Roll the member's monthly contribution back.
      if (payment.contributionId) {
        await tx.$queryRaw`SELECT "id" FROM "contributions" WHERE "id" = ${payment.contributionId} FOR UPDATE`;
        const c = await tx.contribution.findUnique({ where: { id: payment.contributionId } });
        if (c) {
          const newPaid = c.paidPaise > amount ? c.paidPaise - amount : 0n;
          await tx.contribution.update({
            where: { id: c.id },
            data: { paidPaise: newPaid, status: newPaid === 0n ? "PENDING" : "PARTIAL", paidAt: null },
          });
        }
      }

      await tx.notification.create({
        data: {
          userId: payment.userId,
          groupId,
          type: "DEPOSIT_REVERSED",
          title: "A deposit record was corrected",
          body: `${actor.name} reversed a ${formatRupees(amount)} deposit record. Reason: ${reason}`,
        },
      });
      await audit(
        {
          actorId: actor.id,
          groupId,
          action: "TRANSACTION_REVERSED",
          entityType: "LedgerJournal",
          entityId: original.id,
          before: { journalId: original.id, type: original.type, amountPaise: paiseToNumber(amount) },
          after: { reversalJournalId: journal.id, reason },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx
      );

      return { originalId: original.id, reversalId: journal.id };
    });
  } catch (e) {
    // The unique index on reversalOfId caught a parallel attempt.
    if (isUniqueViolation(e)) throw conflict("ALREADY_REVERSED", "This transaction was already reversed.");
    throw e;
  }
}
