import type { PaymentTransaction } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { AppError } from "../../lib/errors";
import { audit } from "../../lib/audit";
import { isUniqueViolation } from "../../lib/dbErrors";
import { lockGroup } from "../../lib/locks";
import { formatRupees } from "../../lib/money";
import { getAccountId, postJournal, type Db, type JournalLine } from "../../lib/ledger";
import { allocateRepayment, isDue, outstanding } from "../../lib/loanRules";
import type { RequestMeta } from "../auth/auth.service";
import { LIVE_STATUSES, refreshLoanStatus } from "./loans.service";
import type { RepaymentInput } from "./loans.schema";

const DAY = 24 * 60 * 60 * 1000;

async function findReplay(db: Db, groupId: string, key: string): Promise<PaymentTransaction | null> {
  const journal = await db.ledgerJournal.findUnique({
    where: { groupId_idempotencyKey: { groupId, idempotencyKey: key } },
    include: { paymentTransaction: true },
  });
  return journal?.paymentTransaction ?? null;
}

type Outcome = { replayed: boolean; payment: PaymentTransaction };

// An administrator records a repayment that really arrived (members pay through the gateway in Phase 9).
export async function recordRepayment(
  groupId: string,
  loanId: string,
  actor: { id: string; name: string },
  input: RepaymentInput,
  meta: RequestMeta
): Promise<Outcome> {
  const now = new Date();
  const paidAt = input.paidAt ?? now;
  if (paidAt.getTime() > now.getTime() + 5 * 60 * 1000) {
    throw new AppError(400, "INVALID_DATE", "The payment date can't be in the future.");
  }
  if (paidAt.getTime() < now.getTime() - 365 * DAY) {
    throw new AppError(400, "INVALID_DATE", "The payment date is more than a year ago.");
  }

  const key = `loan-repay:${input.clientRequestId}`;
  const amount = BigInt(input.amountPaise);

  try {
    return await prisma.$transaction(async (tx): Promise<Outcome> => {
      // Lock FIRST: a parallel identical request waits here, then finds our committed result.
      await lockGroup(tx, groupId);
      const first = await findReplay(tx, groupId, key);
      if (first) return { replayed: true, payment: first };

      const loan = await tx.loan.findFirst({
        where: { id: loanId, groupId },
        include: { user: { select: { name: true } }, installments: { orderBy: { number: "asc" } } },
      });
      if (!loan) throw new AppError(404, "LOAN_NOT_FOUND", "Loan not found.");
      if (loan.userId === actor.id) {
        throw new AppError(
          403,
          "CANNOT_RECORD_OWN_REPAYMENT",
          "You can't record repayments on your own loan. Ask the other administrator to record it."
        );
      }
      if (!LIVE_STATUSES.includes(loan.status)) {
        throw new AppError(409, "LOAN_NOT_ACTIVE", "This loan has no repayments due (it isn't disbursed, or it is already completed).");
      }

      const group = await tx.group.findUniqueOrThrow({
        where: { id: groupId },
        select: { allowPartialRepayment: true, allowEarlyRepayment: true },
      });
      const { allocations, leftover } = allocateRepayment(loan.installments, amount);

      if (leftover > 0n) {
        const total = loan.installments.reduce((s, i) => s + outstanding(i).total, 0n);
        throw new AppError(409, "AMOUNT_EXCEEDS_OUTSTANDING", `Only ${formatRupees(total)} is outstanding on this loan.`);
      }
      if (!group.allowEarlyRepayment) {
        for (const a of allocations) {
          const inst = loan.installments.find((i) => i.id === a.installmentId)!;
          if (!isDue(inst, now)) {
            throw new AppError(409, "EARLY_REPAYMENT_NOT_ALLOWED", `Installment ${a.number} isn't due yet, and this group doesn't allow early repayment.`);
          }
        }
      }
      if (!group.allowPartialRepayment && allocations.some((a) => !a.fullyPaid)) {
        throw new AppError(409, "PARTIAL_PAYMENT_NOT_ALLOWED", "This group doesn't allow partial payments: pay each installment in full.");
      }

      // The payment record. The UTR goes in the globally-unique column shared with deposits.
      const providerPaymentId = input.paymentReference
        ? `manual:${groupId}:${input.paymentReference.toUpperCase()}`
        : null;
      const payment = await tx.paymentTransaction.create({
        data: {
          groupId,
          userId: loan.userId,
          purpose: "LOAN_REPAYMENT",
          amountPaise: amount,
          method: input.method,
          status: "SUCCESS",
          providerPaymentId,
          loanId: loan.id,
          recordedById: actor.id,
          evidenceNote: input.evidenceNote,
          evidenceUrl: input.evidenceUrl ?? null,
          paidAt,
        },
      });

      let principalTotal = 0n;
      let interestTotal = 0n;
      for (const a of allocations) {
        principalTotal += a.principalPaise;
        interestTotal += a.interestPaise;
        await tx.loanRepayment.create({
          data: {
            loanId: loan.id,
            groupId,
            userId: loan.userId,
            installmentId: a.installmentId,
            amountPaise: a.amountPaise,
            principalPortionPaise: a.principalPaise,
            interestPortionPaise: a.interestPaise,
            paymentTransactionId: payment.id,
            paidAt,
          },
        });
        await tx.loanInstallment.update({
          where: { id: a.installmentId },
          data: { paidPaise: a.newPaidPaise, ...(a.fullyPaid ? { paidAt } : {}) },
        });
      }

      // Re-derive installment and loan statuses from the new numbers.
      const byId = new Map(allocations.map((a) => [a.installmentId, a]));
      const updated = loan.installments.map((i) => {
        const a = byId.get(i.id);
        return a ? { ...i, paidPaise: a.newPaidPaise } : i;
      });
      const newStatus = await refreshLoanStatus(tx, loan, updated, now);

      // Ledger: cash in; the member's debt shrinks by the principal part; the interest part is income.
      const bank = await getAccountId(tx, groupId, "BANK_CLEARING");
      const receivable = await getAccountId(tx, groupId, "LOANS_RECEIVABLE", loan.userId);
      const lines: JournalLine[] = [{ accountId: bank, direction: "DEBIT", amountPaise: amount }];
      if (principalTotal > 0n) lines.push({ accountId: receivable, direction: "CREDIT", amountPaise: principalTotal });
      if (interestTotal > 0n) {
        const income = await getAccountId(tx, groupId, "INTEREST_INCOME");
        lines.push({ accountId: income, direction: "CREDIT", amountPaise: interestTotal });
      }
      const { journal } = await postJournal(tx, {
        groupId,
        type: "LOAN_REPAYMENT",
        description: `Loan repayment from ${loan.user.name} (${formatRupees(principalTotal)} principal, ${formatRupees(interestTotal)} interest)`,
        createdById: actor.id,
        paymentTransactionId: payment.id,
        loanId: loan.id,
        occurredAt: paidAt,
        idempotencyKey: key,
        lines,
      });

      await tx.notification.create({
        data: {
          userId: loan.userId,
          groupId,
          type: "LOAN_REPAYMENT_RECORDED",
          title: newStatus === "COMPLETED" ? "Your loan is fully repaid" : "Repayment recorded",
          body: `${actor.name} recorded your repayment of ${formatRupees(amount)}.`,
        },
      });
      await audit(
        {
          actorId: actor.id,
          groupId,
          action: "LOAN_REPAYMENT_RECORDED",
          entityType: "PaymentTransaction",
          entityId: payment.id,
          after: {
            loanId: loan.id,
            amountPaise: input.amountPaise,
            principalPaise: Number(principalTotal),
            interestPaise: Number(interestTotal),
            method: input.method,
            reference: input.paymentReference ?? null,
            journalId: journal.id,
            loanStatus: newStatus,
          },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx
      );

      return { replayed: false, payment };
    });
  } catch (e) {
    // Any conflict may just mean OUR OWN identical request committed a moment ago.
    if ((e instanceof AppError && e.status === 409) || isUniqueViolation(e)) {
      const existing = await findReplay(prisma, groupId, key);
      if (existing) return { replayed: true, payment: existing };
    }
    if (isUniqueViolation(e)) {
      throw new AppError(409, "DUPLICATE_PAYMENT_REFERENCE", "This payment reference has already been recorded.");
    }
    throw e;
  }
}
