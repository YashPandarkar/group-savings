import type { Contribution, GroupRole, PaymentTransaction, Prisma } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { AppError } from "../../lib/errors";
import { audit } from "../../lib/audit";
import { can } from "../../lib/permissions";
import { formatRupees, paiseToNumber } from "../../lib/money";
import { isUniqueViolation } from "../../lib/dbErrors";
import { ensureMemberAccounts } from "../../lib/ledgerAccounts";
import { getAccountId, postJournal, type Db } from "../../lib/ledger";
import { periodIndex, periodOf } from "../../lib/period";
import type { RequestMeta } from "../auth/auth.service";
import { ensureContributions } from "./contributions.service";
import type { ManualDepositInput } from "./contributions.schema";

const DAY = 24 * 60 * 60 * 1000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function serializeDeposit(p: PaymentTransaction, opts: { evidence: boolean }) {
  const ref = p.providerPaymentId?.startsWith("manual:")
    ? p.providerPaymentId.split(":").slice(2).join(":")
    : p.providerPaymentId;
  return {
    id: p.id,
    userId: p.userId,
    purpose: p.purpose,
    amountPaise: paiseToNumber(p.amountPaise),
    method: p.method,
    status: p.status,
    reference: ref,
    // MANUAL = an admin recorded it. GATEWAY = verified by the payment provider (Phase 9).
    source: p.recordedById ? "MANUAL" : "GATEWAY",
    contributionId: p.contributionId,
    paidAt: p.paidAt,
    createdAt: p.createdAt,
    // Evidence details are for administrators only.
    ...(opts.evidence
      ? { recordedById: p.recordedById, evidenceNote: p.evidenceNote, evidenceUrl: p.evidenceUrl }
      : {}),
  };
}

async function findReplay(db: Db, groupId: string, key: string): Promise<PaymentTransaction | null> {
  const journal = await db.ledgerJournal.findUnique({
    where: { groupId_idempotencyKey: { groupId, idempotencyKey: key } },
    include: { paymentTransaction: true },
  });
  return journal?.paymentTransaction ?? null;
}

type Outcome = { replayed: boolean; payment: PaymentTransaction };

export async function recordManualDeposit(
  groupId: string,
  actor: { id: string; name: string },
  input: ManualDepositInput,
  meta: RequestMeta
): Promise<Outcome> {
  // Separation of duties: nobody records money into their own account.
  if (input.userId === actor.id) {
    throw new AppError(
      403,
      "CANNOT_RECORD_OWN_DEPOSIT",
      "You can't record your own deposit. Ask the other administrator to record it (appoint a Vice President if you haven't)."
    );
  }

  const now = new Date();
  const paidAt = input.paidAt ?? now;
  if (paidAt.getTime() > now.getTime() + 5 * 60 * 1000) {
    throw new AppError(400, "INVALID_DATE", "The payment date can't be in the future.");
  }
  if (paidAt.getTime() < now.getTime() - 365 * DAY) {
    throw new AppError(400, "INVALID_DATE", "The payment date is more than a year ago.");
  }

  const key = `deposit:${input.clientRequestId}`;
  const amount = BigInt(input.amountPaise);

  try {
    return await prisma.$transaction(async (tx): Promise<Outcome> => {
      // 1. Same request seen before? Return the original result.
      const first = await findReplay(tx, groupId, key);
      if (first) return { replayed: true, payment: first };

      // 2. The member must be ACTIVE in THIS group.
      const target = await tx.groupMember.findFirst({
        where: { groupId, userId: input.userId, status: "ACTIVE" },
        include: { user: { select: { name: true } } },
      });
      if (!target) throw new AppError(404, "MEMBER_NOT_FOUND", "Member not found.");
      await ensureMemberAccounts(tx, groupId, target.userId);

      // 3. Monthly deposits: pick the contribution row, lock it, validate the amount.
      let contribution: Contribution | null = null;
      if (input.purpose === "MONTHLY_DEPOSIT") {
        const cur = periodOf(now);
        await ensureContributions(tx, groupId, cur.year, cur.month);

        let candidateId: string;
        if (input.periodYear !== undefined && input.periodMonth !== undefined) {
          if (periodIndex(input.periodYear, input.periodMonth) > periodIndex(cur.year, cur.month)) {
            throw new AppError(400, "FUTURE_PERIOD", "You can't record a deposit for a future month.");
          }
          const row = await tx.contribution.findUnique({
            where: {
              groupId_userId_periodYear_periodMonth: {
                groupId,
                userId: target.userId,
                periodYear: input.periodYear,
                periodMonth: input.periodMonth,
              },
            },
          });
          if (!row) {
            throw new AppError(
              409,
              "NO_CONTRIBUTION_DUE",
              "This member has no contribution due for that month. Record it as an additional deposit instead."
            );
          }
          candidateId = row.id;
        } else {
          // Default: the OLDEST unpaid month.
          const oldest = await tx.contribution.findFirst({
            where: { groupId, userId: target.userId, status: { in: ["PENDING", "PARTIAL"] } },
            orderBy: [{ periodYear: "asc" }, { periodMonth: "asc" }],
            select: { id: true },
          });
          if (!oldest) {
            throw new AppError(
              409,
              "NOTHING_DUE",
              "This member has no unpaid monthly contribution. Record it as an additional deposit instead."
            );
          }
          candidateId = oldest.id;
        }

        // Lock the row: a concurrent request for the same contribution now WAITS here.
        await tx.$queryRaw`SELECT "id" FROM "contributions" WHERE "id" = ${candidateId} FOR UPDATE`;

        // If we waited, the other request may have been OUR OWN retry. Check again.
        const second = await findReplay(tx, groupId, key);
        if (second) return { replayed: true, payment: second };

        // Re-read AFTER the lock so we see the latest numbers.
        contribution = await tx.contribution.findUniqueOrThrow({ where: { id: candidateId } });
        if (contribution.status === "PAID") {
          throw new AppError(409, "CONTRIBUTION_ALREADY_PAID", "That contribution is already fully paid.");
        }
        if (contribution.status === "WAIVED") {
          throw new AppError(409, "CONTRIBUTION_WAIVED", "That contribution was waived.");
        }
        const remaining = contribution.expectedPaise - contribution.paidPaise;
        if (amount > remaining) {
          throw new AppError(
            409,
            "AMOUNT_EXCEEDS_DUE",
            `Only ${formatRupees(remaining)} is still due for that month. Record the extra as an additional deposit.`
          );
        }
      }

      // 4. The payment record. The UTR goes into a globally-unique column, so the same
      //    bank transaction can't be recorded twice. The prefix keeps groups separate.
      const providerPaymentId = input.paymentReference
        ? `manual:${groupId}:${input.paymentReference.toUpperCase()}`
        : null;
      const payment = await tx.paymentTransaction.create({
        data: {
          groupId,
          userId: target.userId,
          purpose: input.purpose,
          amountPaise: amount,
          method: input.method,
          status: "SUCCESS",
          providerPaymentId,
          contributionId: contribution?.id ?? null,
          recordedById: actor.id,
          evidenceNote: input.evidenceNote,
          evidenceUrl: input.evidenceUrl ?? null,
          paidAt,
        },
      });

      // 5. Update the contribution.
      let label = "Additional deposit";
      if (contribution) {
        const newPaid = contribution.paidPaise + amount;
        const done = newPaid >= contribution.expectedPaise;
        await tx.contribution.update({
          where: { id: contribution.id },
          data: {
            paidPaise: newPaid,
            status: done ? "PAID" : "PARTIAL",
            paidAt: done ? paidAt : contribution.paidAt,
          },
        });
        label = `Monthly deposit (${MONTHS[contribution.periodMonth - 1]} ${contribution.periodYear})`;
      }

      // 6. The ledger. Money in:  DEBIT bank (asset up),  CREDIT member savings (what we owe them up).
      const bankId = await getAccountId(tx, groupId, "BANK_CLEARING");
      const savingsId = await getAccountId(tx, groupId, "MEMBER_SAVINGS", target.userId);
      const { journal } = await postJournal(tx, {
        groupId,
        type: input.purpose,
        description: `${label} from ${target.user.name}`,
        createdById: actor.id,
        paymentTransactionId: payment.id,
        occurredAt: paidAt,
        idempotencyKey: key,
        lines: [
          { accountId: bankId, direction: "DEBIT", amountPaise: amount },
          { accountId: savingsId, direction: "CREDIT", amountPaise: amount },
        ],
      });

      // 7. Tell the member, and leave an audit trail. Same transaction: all or nothing.
      await tx.notification.create({
        data: {
          userId: target.userId,
          groupId,
          type: "DEPOSIT_RECORDED",
          title: "Deposit recorded",
          body: `${actor.name} recorded your deposit of ${formatRupees(amount)}.`,
        },
      });
      await audit(
        {
          actorId: actor.id,
          groupId,
          action: "DEPOSIT_RECORDED_MANUAL",
          entityType: "PaymentTransaction",
          entityId: payment.id,
          after: {
            memberUserId: target.userId,
            purpose: input.purpose,
            amountPaise: input.amountPaise,
            method: input.method,
            reference: input.paymentReference ?? null,
            journalId: journal.id,
            contributionId: contribution?.id ?? null,
          },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx
      );

      return { replayed: false, payment };
    });
  } catch (e) {
    // Any "conflict" might just mean OUR OWN identical request committed a moment ago.
    // Look from outside the failed transaction, where committed rows are visible.
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

// Administrators see every deposit; members see only their own.
export async function listDeposits(
  groupId: string,
  viewer: { userId: string; role: GroupRole },
  page: number,
  pageSize: number
) {
  const admin = can(viewer.role, "contribution:view_all");
  const where: Prisma.PaymentTransactionWhereInput = {
    groupId,
    purpose: { in: ["MONTHLY_DEPOSIT", "ADDITIONAL_DEPOSIT"] },
    ...(admin ? {} : { userId: viewer.userId }),
  };
  const [total, rows] = await prisma.$transaction([
    prisma.paymentTransaction.count({ where }),
    prisma.paymentTransaction.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { user: { select: { name: true } } },
    }),
  ]);
  return {
    page,
    pageSize,
    total,
    items: rows.map((r) => ({ ...serializeDeposit(r, { evidence: admin }), memberName: r.user.name })),
  };
}
