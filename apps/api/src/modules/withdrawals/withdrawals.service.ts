import type { GroupRole, Prisma, WithdrawalStatus } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { AppError } from "../../lib/errors";
import { audit } from "../../lib/audit";
import { can } from "../../lib/permissions";
import { lockGroup } from "../../lib/locks";
import { formatRupees, paiseToNumber } from "../../lib/money";
import { ensureMemberAccounts, memberSavingsBalance } from "../../lib/ledgerAccounts";
import { getAccountId, groupFundBalance, postJournal } from "../../lib/ledger";
import { committedFunds, groupSurplus, outstandingLoanPrincipal, reservedWithdrawals } from "../../lib/commitments";
import type { RequestMeta } from "../auth/auth.service";
import type { CompleteInput, RequestWithdrawalInput, WithdrawalListQuery } from "./withdrawals.schema";

type Tx = Prisma.TransactionClient;
export type Viewer = { userId: string; role: GroupRole };
export type Actor = { id: string; name: string; role: GroupRole };

const notFound = () => new AppError(404, "WITHDRAWAL_NOT_FOUND", "Withdrawal not found.");
const invalidState = (status: WithdrawalStatus, action: string) =>
  new AppError(409, "INVALID_STATE", `This withdrawal is ${status.toLowerCase()} and can't be ${action}.`);

const include = {
  requestedBy: { select: { name: true } },
  approvedBy: { select: { name: true } },
  secondApprover: { select: { name: true } },
  beneficiary: { select: { name: true } },
  completedBy: { select: { name: true } },
} satisfies Prisma.WithdrawalInclude;
type Row = Prisma.WithdrawalGetPayload<{ include: typeof include }>;

const STATUS_NOTE: Record<WithdrawalStatus, string> = {
  PENDING: "Waiting for a second approval. Nothing has been reserved or sent.",
  APPROVED: "Approved and the money is reserved, but NOTHING HAS BEEN SENT until an administrator records the transfer.",
  COMPLETED: "An administrator recorded that a transfer was made. Check your bank account to confirm it arrived.",
  REJECTED: "This request was rejected.",
  CANCELLED: "This request was withdrawn by the person who made it.",
};

export function serializeWithdrawal(w: Row, admin: boolean) {
  return {
    id: w.id,
    groupId: w.groupId,
    kind: w.beneficiaryId ? "MEMBER_PAYOUT" : "GROUP_EXPENSE",
    amountPaise: paiseToNumber(w.amountPaise),
    purpose: w.purpose,
    status: w.status,
    statusNote: STATUS_NOTE[w.status],
    beneficiary: w.beneficiaryId ? { userId: w.beneficiaryId, name: w.beneficiary?.name ?? "Unknown" } : null,
    requestedAt: w.createdAt,
    completedAt: w.completedAt,
    paymentReference: w.paymentReference,
    // Administrators also see who did what.
    ...(admin
      ? {
          requestedBy: { userId: w.requestedById, name: w.requestedBy.name },
          firstApprovalBy: w.approvedBy?.name ?? null,
          secondApprovalBy: w.secondApprover?.name ?? null,
          approvedAt: w.approvedAt,
          secondApprovedAt: w.secondApprovedAt,
          rejectionReason: w.rejectionReason,
          method: w.method,
          completedBy: w.completedBy?.name ?? null,
        }
      : {}),
  };
}

async function notifyAdmins(tx: Tx, groupId: string, exceptUserId: string, type: string, title: string, body: string) {
  const admins = await tx.groupMember.findMany({
    where: { groupId, status: "ACTIVE", role: { in: ["PRESIDENT", "VICE_PRESIDENT"] }, userId: { not: exceptUserId } },
    select: { userId: true },
  });
  if (admins.length > 0) {
    await tx.notification.createMany({ data: admins.map((a) => ({ userId: a.userId, groupId, type, title, body })) });
  }
}

// ───────────── the money rules ─────────────

// Can this much leave right now? Called under the group lock at request, approval AND completion.
// `excludeId` is the withdrawal being checked, so it doesn't count against itself.
async function assertAvailable(
  tx: Tx,
  groupId: string,
  w: { beneficiaryId: string | null; amount: bigint },
  excludeId?: string
): Promise<void> {
  // 1. Cash: the fund minus everything already promised.
  const fund = await groupFundBalance(tx, groupId);
  const committed = await committedFunds(tx, groupId, excludeId);
  const cash = fund - committed;
  if (w.amount > cash) {
    throw new AppError(
      409,
      "INSUFFICIENT_FUND",
      `The fund available for withdrawals is ${formatRupees(cash < 0n ? 0n : cash)} (after approved loans and withdrawals), which can't cover ${formatRupees(w.amount)}.`
    );
  }

  if (w.beneficiaryId) {
    // 2a. A payout can't exceed the member's own savings, less what they owe and what is already reserved for them.
    const savings = await memberSavingsBalance(tx, groupId, w.beneficiaryId);
    const owed = await outstandingLoanPrincipal(tx, groupId, w.beneficiaryId);
    const reserved = await reservedWithdrawals(tx, groupId, w.beneficiaryId, excludeId);
    const allowed = savings - owed - reserved;
    if (w.amount > allowed) {
      throw new AppError(
        409,
        "MEMBER_BALANCE_TOO_LOW",
        `This member can be paid at most ${formatRupees(allowed < 0n ? 0n : allowed)} (savings ${formatRupees(savings)}, less ${formatRupees(owed)} still owed on loans and ${formatRupees(reserved)} already reserved).`
      );
    }
  } else {
    // 2b. A group expense can only come from what the group EARNED (interest), never from members' savings.
    const surplus = await groupSurplus(tx, groupId);
    const reserved = await reservedWithdrawals(tx, groupId, null, excludeId);
    const allowed = surplus - reserved;
    if (w.amount > allowed) {
      throw new AppError(
        409,
        "INSUFFICIENT_SURPLUS",
        `Group expenses can only use interest earned. ${formatRupees(allowed < 0n ? 0n : allowed)} is available, which can't cover ${formatRupees(w.amount)}.`
      );
    }
  }
}

async function findOrThrow(tx: Tx, groupId: string, id: string) {
  const w = await tx.withdrawal.findFirst({ where: { id, groupId }, include }); // groupId = tenant isolation
  if (!w) throw notFound();
  return w;
}

// ───────────── request ─────────────

export async function requestWithdrawal(
  groupId: string,
  actor: Actor,
  input: RequestWithdrawalInput,
  meta: RequestMeta
): Promise<{ replayed: boolean; id: string }> {
  return prisma.$transaction(async (tx) => {
    await lockGroup(tx, groupId);
    const amount = BigInt(input.amountPaise);
    const group = await tx.group.findUniqueOrThrow({ where: { id: groupId }, select: { requireDualApproval: true } });

    let beneficiaryId: string | null = null;
    if (input.kind === "MEMBER_PAYOUT") {
      const m = await tx.groupMember.findFirst({
        where: { groupId, userId: input.beneficiaryUserId, status: "ACTIVE" },
        select: { userId: true },
      });
      if (!m) throw new AppError(404, "MEMBER_NOT_FOUND", "Member not found.");
      beneficiaryId = m.userId;
    }

    // A double-click: the identical open request from a moment ago is returned instead of duplicated.
    const recent = await tx.withdrawal.findFirst({
      where: {
        groupId, requestedById: actor.id, amountPaise: amount, purpose: input.purpose, beneficiaryId,
        status: { in: ["PENDING", "APPROVED"] },
        createdAt: { gt: new Date(Date.now() - 60_000) },
      },
      select: { id: true },
    });
    if (recent) return { replayed: true, id: recent.id };

    // Dual approval is on, or an administrator is paying out THEIR OWN savings: someone else must approve.
    const needsSecond = group.requireDualApproval || beneficiaryId === actor.id;
    if (needsSecond) {
      const eligible = await tx.groupMember.count({
        where: {
          groupId, status: "ACTIVE", role: { in: ["PRESIDENT", "VICE_PRESIDENT"] },
          userId: { notIn: beneficiaryId ? [actor.id, beneficiaryId] : [actor.id] },
        },
      });
      if (eligible === 0) {
        throw new AppError(
          409,
          "NO_SECOND_APPROVER",
          "This withdrawal needs a second approval, but no other administrator can give it. Appoint a Vice President, or ask the other administrator to make the request."
        );
      }
    }

    await assertAvailable(tx, groupId, { beneficiaryId, amount });

    const now = new Date();
    const w = await tx.withdrawal.create({
      data: {
        groupId,
        amountPaise: amount,
        purpose: input.purpose,
        beneficiaryId,
        requestedById: actor.id,
        approvedById: actor.id, // the request is the first sign-off
        approvedAt: now,
        status: needsSecond ? "PENDING" : "APPROVED",
      },
    });

    if (needsSecond) {
      await notifyAdmins(tx, groupId, actor.id, "WITHDRAWAL_APPROVAL_NEEDED", "A withdrawal needs your approval",
        `${actor.name} requested ${formatRupees(amount)}: ${input.purpose}`);
    }
    await audit(
      {
        actorId: actor.id,
        groupId,
        action: "WITHDRAWAL_REQUESTED",
        entityType: "Withdrawal",
        entityId: w.id,
        after: {
          kind: beneficiaryId ? "MEMBER_PAYOUT" : "GROUP_EXPENSE",
          amountPaise: input.amountPaise,
          purpose: input.purpose,
          beneficiaryUserId: beneficiaryId,
          status: w.status,
        },
        ip: meta.ip,
        userAgent: meta.userAgent,
      },
      tx
    );
    return { replayed: false, id: w.id };
  });
}

// ───────────── approve / reject / cancel ─────────────

export async function approveWithdrawal(groupId: string, id: string, actor: Actor, note: string | undefined, meta: RequestMeta) {
  await prisma.$transaction(async (tx) => {
    await lockGroup(tx, groupId);
    const w = await findOrThrow(tx, groupId, id);
    if (w.requestedById === actor.id) {
      throw new AppError(403, "CANNOT_APPROVE_OWN_REQUEST", "You can't approve your own request. The other administrator must do it.");
    }
    if (w.beneficiaryId === actor.id) {
      throw new AppError(403, "CANNOT_APPROVE_OWN_PAYOUT", "You can't approve a payout to yourself.");
    }
    if (w.status !== "PENDING") throw invalidState(w.status, "approved");

    await assertAvailable(tx, groupId, { beneficiaryId: w.beneficiaryId, amount: w.amountPaise }, w.id);

    await tx.withdrawal.update({
      where: { id: w.id },
      data: { status: "APPROVED", secondApprovedById: actor.id, secondApprovedAt: new Date() },
    });
    await tx.notification.create({
      data: {
        userId: w.requestedById, groupId, type: "WITHDRAWAL_APPROVED", title: "Your withdrawal was approved",
        body: `${actor.name} approved ${formatRupees(w.amountPaise)}. Record the transfer once the money is actually sent.`,
      },
    });
    await audit(
      {
        actorId: actor.id, groupId, action: "WITHDRAWAL_APPROVED", entityType: "Withdrawal", entityId: w.id,
        before: { status: w.status }, after: { status: "APPROVED", note: note ?? null },
        ip: meta.ip, userAgent: meta.userAgent,
      },
      tx
    );
  });
}

export async function rejectWithdrawal(groupId: string, id: string, actor: Actor, reason: string, meta: RequestMeta) {
  await prisma.$transaction(async (tx) => {
    await lockGroup(tx, groupId);
    const w = await findOrThrow(tx, groupId, id);
    if (w.requestedById === actor.id) {
      throw new AppError(403, "CANNOT_REJECT_OWN_REQUEST", "You can't reject your own request. Withdraw it with Cancel instead.");
    }
    if (w.status !== "PENDING" && w.status !== "APPROVED") throw invalidState(w.status, "rejected");

    await tx.withdrawal.update({ where: { id: w.id }, data: { status: "REJECTED", rejectionReason: reason } });
    await tx.notification.create({
      data: {
        userId: w.requestedById, groupId, type: "WITHDRAWAL_REJECTED", title: "Your withdrawal was rejected",
        body: `${actor.name} rejected ${formatRupees(w.amountPaise)}. Reason: ${reason}`,
      },
    });
    await audit(
      {
        actorId: actor.id, groupId, action: "WITHDRAWAL_REJECTED", entityType: "Withdrawal", entityId: w.id,
        before: { status: w.status }, after: { status: "REJECTED", reason },
        ip: meta.ip, userAgent: meta.userAgent,
      },
      tx
    );
  });
}

export async function cancelWithdrawal(groupId: string, id: string, actor: Actor, meta: RequestMeta) {
  await prisma.$transaction(async (tx) => {
    await lockGroup(tx, groupId);
    const w = await findOrThrow(tx, groupId, id);
    if (w.requestedById !== actor.id) {
      throw new AppError(403, "FORBIDDEN", "Only the person who made the request can withdraw it. Others can reject it.");
    }
    if (w.status !== "PENDING" && w.status !== "APPROVED") throw invalidState(w.status, "cancelled");

    await tx.withdrawal.update({ where: { id: w.id }, data: { status: "CANCELLED" } });
    await audit(
      {
        actorId: actor.id, groupId, action: "WITHDRAWAL_CANCELLED", entityType: "Withdrawal", entityId: w.id,
        before: { status: w.status }, after: { status: "CANCELLED" }, ip: meta.ip, userAgent: meta.userAgent,
      },
      tx
    );
  });
}

// ───────────── completion: a REAL transfer happened ─────────────

export async function completeWithdrawal(
  groupId: string,
  id: string,
  actor: Actor,
  input: CompleteInput,
  meta: RequestMeta
): Promise<{ replayed: boolean }> {
  return prisma.$transaction(async (tx) => {
    await lockGroup(tx, groupId); // a parallel identical request waits here, then finds our result
    const w = await findOrThrow(tx, groupId, id);
    const ref = input.reference?.toUpperCase() ?? "CASH";

    if (w.status === "COMPLETED") {
      if (w.paymentReference === ref) return { replayed: true }; // a retry or double-click
      throw new AppError(409, "ALREADY_COMPLETED", "This withdrawal was already completed with a different reference.");
    }
    if (w.status !== "APPROVED") throw invalidState(w.status, "completed (it must be approved first)");
    if (w.beneficiaryId === actor.id) {
      throw new AppError(403, "CANNOT_COMPLETE_OWN_PAYOUT", "You can't record the transfer of your own payout. The other administrator must do it.");
    }
    if (ref !== "CASH") {
      const dup = await tx.withdrawal.findFirst({
        where: { groupId, paymentReference: ref, id: { not: w.id } },
        select: { id: true },
      });
      if (dup) throw new AppError(409, "DUPLICATE_PAYMENT_REFERENCE", "This transfer reference has already been recorded.");
    }

    // Re-check against the situation RIGHT NOW (a lot can change between approval and transfer).
    await assertAvailable(tx, groupId, { beneficiaryId: w.beneficiaryId, amount: w.amountPaise }, w.id);

    // Ledger: cash goes out, and either the member's savings or the group's earned surplus goes down.
    const bank = await getAccountId(tx, groupId, "BANK_CLEARING");
    let debitAccount: string;
    if (w.beneficiaryId) {
      await ensureMemberAccounts(tx, groupId, w.beneficiaryId);
      debitAccount = await getAccountId(tx, groupId, "MEMBER_SAVINGS", w.beneficiaryId);
    } else {
      debitAccount = await getAccountId(tx, groupId, "GROUP_EQUITY");
    }
    const now = new Date();
    const { journal } = await postJournal(tx, {
      groupId,
      type: "GROUP_WITHDRAWAL",
      description: w.beneficiaryId
        ? `Savings payout to ${w.beneficiary?.name ?? "member"}: ${w.purpose}`
        : `Group expense: ${w.purpose}`,
      createdById: actor.id,
      approvedById: w.secondApprovedById ?? w.approvedById ?? undefined,
      withdrawalId: w.id,
      occurredAt: now,
      idempotencyKey: `withdrawal:${w.id}`,
      lines: [
        { accountId: debitAccount, direction: "DEBIT", amountPaise: w.amountPaise },
        { accountId: bank, direction: "CREDIT", amountPaise: w.amountPaise },
      ],
    });

    await tx.withdrawal.update({
      where: { id: w.id },
      data: { status: "COMPLETED", paymentReference: ref, method: input.method, completedById: actor.id, completedAt: now },
    });

    const amountText = formatRupees(w.amountPaise);
    if (w.beneficiaryId) {
      await tx.notification.create({
        data: {
          userId: w.beneficiaryId, groupId, type: "WITHDRAWAL_COMPLETED", title: "Your savings payout was recorded",
          body: `${actor.name} recorded a transfer of ${amountText} to you (${input.method}${ref !== "CASH" ? `, ref ${ref}` : ""}). Please check your bank account and tell the group if it hasn't arrived.`,
        },
      });
    }
    await audit(
      {
        actorId: actor.id, groupId, action: "WITHDRAWAL_COMPLETED", entityType: "Withdrawal", entityId: w.id,
        before: { status: w.status },
        after: {
          status: "COMPLETED", amountPaise: paiseToNumber(w.amountPaise), method: input.method,
          reference: ref, note: input.note, journalId: journal.id,
        },
        ip: meta.ip, userAgent: meta.userAgent,
      },
      tx
    );
    return { replayed: false };
  });
}

// ───────────── reading ─────────────

export async function getWithdrawal(groupId: string, id: string, viewer: Viewer) {
  const admin = can(viewer.role, "withdrawal:view");
  const w = await prisma.withdrawal.findFirst({ where: { id, groupId }, include });
  // Members may only see payouts made TO THEM. Anything else looks like it doesn't exist.
  if (!w || (!admin && w.beneficiaryId !== viewer.userId)) throw notFound();
  return serializeWithdrawal(w, admin);
}

export async function listWithdrawals(groupId: string, viewer: Viewer, q: WithdrawalListQuery) {
  const admin = can(viewer.role, "withdrawal:view");
  const where: Prisma.WithdrawalWhereInput = {
    groupId,
    ...(admin ? {} : { beneficiaryId: viewer.userId }),
    ...(q.status ? { status: q.status } : {}),
  };
  const [total, rows] = await prisma.$transaction([
    prisma.withdrawal.count({ where }),
    prisma.withdrawal.findMany({
      where, orderBy: { createdAt: "desc" }, skip: (q.page - 1) * q.pageSize, take: q.pageSize, include,
    }),
  ]);
  return { page: q.page, pageSize: q.pageSize, total, items: rows.map((r) => serializeWithdrawal(r, admin)) };
}

// President / VP.
export async function withdrawalReport(groupId: string) {
  const rows = await prisma.withdrawal.findMany({ where: { groupId }, orderBy: { createdAt: "desc" }, include });
  const sum = (pred: (r: Row) => boolean) => rows.filter(pred).reduce((s, r) => s + r.amountPaise, 0n);
  const count = (pred: (r: Row) => boolean) => rows.filter(pred).length;
  const done = (r: Row) => r.status === "COMPLETED";
  return {
    basis: "RECORDS",
    summary: {
      completedPaise: paiseToNumber(sum(done)),
      payoutsCompletedPaise: paiseToNumber(sum((r) => done(r) && r.beneficiaryId !== null)),
      expensesCompletedPaise: paiseToNumber(sum((r) => done(r) && r.beneficiaryId === null)),
      awaitingApprovalCount: count((r) => r.status === "PENDING"),
      awaitingApprovalPaise: paiseToNumber(sum((r) => r.status === "PENDING")),
      awaitingTransferCount: count((r) => r.status === "APPROVED"),
      awaitingTransferPaise: paiseToNumber(sum((r) => r.status === "APPROVED")),
      rejectedCount: count((r) => r.status === "REJECTED"),
      cancelledCount: count((r) => r.status === "CANCELLED"),
    },
    items: rows.slice(0, 100).map((r) => serializeWithdrawal(r, true)),
  };
}
