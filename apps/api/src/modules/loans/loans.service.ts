import type { GroupRole, LoanInstallment, LoanStatus, Prisma } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { AppError } from "../../lib/errors";
import { audit } from "../../lib/audit";
import { can } from "../../lib/permissions";
import { lockGroup } from "../../lib/locks";
import { formatRupees, paiseToNumber } from "../../lib/money";
import { computeSchedule, type LoanTerms, type ScheduleRow } from "../../lib/interest";
import { installmentDueDate } from "../../lib/loanDates";
import { deriveInstallmentStatus, deriveLoanStatus, outstanding, paidSplit } from "../../lib/loanRules";
import { ensureMemberAccounts } from "../../lib/ledgerAccounts";
import { getAccountId, groupFundBalance, postJournal } from "../../lib/ledger";
import type { RequestMeta } from "../auth/auth.service";
import type { ApplyLoanInput, DisburseInput, LoanListQuery, QuoteQuery } from "./loans.schema";

type Tx = Prisma.TransactionClient;
export type Viewer = { userId: string; role: GroupRole };
export type Actor = { id: string; name: string; role: GroupRole };

export const LIVE_STATUSES: LoanStatus[] = ["DISBURSED", "ACTIVE", "PARTIALLY_PAID", "OVERDUE"];
const PREVIEW_STATUSES: LoanStatus[] = ["PENDING", "UNDER_REVIEW", "APPROVED"];

const notFound = () => new AppError(404, "LOAN_NOT_FOUND", "Loan not found.");
const invalidState = (status: LoanStatus, action: string) =>
  new AppError(409, "INVALID_STATE", `This loan is ${status.replace("_", " ").toLowerCase()} and can't be ${action}.`);

const loanInclude = {
  user: { select: { name: true } },
  approvedBy: { select: { name: true } },
  disbursedBy: { select: { name: true } },
  installments: { orderBy: { number: "asc" } },
} satisfies Prisma.LoanInclude;
type LoanRow = Prisma.LoanGetPayload<{ include: typeof loanInclude }>;

type TermsSource = Pick<
  LoanRow,
  "principalPaise" | "installmentCount" | "repaymentFrequency" | "interestMethod" | "interestRateBps"
>;
const termsOf = (l: TermsSource): LoanTerms => ({
  principalPaise: l.principalPaise,
  installmentCount: l.installmentCount,
  repaymentFrequency: l.repaymentFrequency,
  interestMethod: l.interestMethod,
  interestRateBps: l.interestRateBps,
});

function scheduleOrThrow(terms: LoanTerms): ScheduleRow[] {
  try {
    return computeSchedule(terms);
  } catch (e) {
    throw new AppError(400, "INVALID_LOAN_TERMS", e instanceof Error ? e.message : "Invalid loan terms.");
  }
}
const sumTotals = (rows: ScheduleRow[]) => rows.reduce((s, r) => s + r.totalPaise, 0n);

export function policyText(method: string, bps: number, frequency: string): string {
  const rate = `${(bps / 100).toFixed(2)}% per year`;
  const every = frequency === "WEEKLY" ? "weekly" : "monthly";
  if (method === "NONE" || bps === 0) return `No interest, repaid in ${every} installments.`;
  if (method === "FLAT") return `Flat interest at ${rate} on the original amount, repaid in ${every} installments.`;
  return `Reducing-balance interest at ${rate}, repaid in ${every} installments.`;
}

const rowOut = (r: ScheduleRow) => ({
  number: r.number,
  principalPaise: paiseToNumber(r.principalPaise),
  interestPaise: paiseToNumber(r.interestPaise),
  totalPaise: paiseToNumber(r.totalPaise),
});

export function serializeInstallment(i: LoanInstallment, now: Date) {
  const split = paidSplit(i);
  const remaining = outstanding(i).total;
  return {
    id: i.id,
    number: i.number,
    dueDate: i.dueDate,
    principalPaise: paiseToNumber(i.principalPaise),
    interestPaise: paiseToNumber(i.interestPaise),
    totalDuePaise: paiseToNumber(i.totalDuePaise),
    paidPaise: paiseToNumber(i.paidPaise),
    remainingPaise: paiseToNumber(remaining),
    principalPaidPaise: paiseToNumber(split.principalPaid),
    interestPaidPaise: paiseToNumber(split.interestPaid),
    status: i.status,
    overdue: remaining > 0n && i.dueDate < now,
    paidAt: i.paidAt,
  };
}

export function serializeLoan(l: LoanRow, now: Date, withInstallments = true) {
  const insts = l.installments;
  const hasSchedule = insts.length > 0;
  let paid = 0n, due = 0n, outPrincipal = 0n, outInterest = 0n, overdue = 0n;
  for (const i of insts) {
    paid += i.paidPaise;
    due += i.totalDuePaise;
    const o = outstanding(i);
    outPrincipal += o.principal;
    outInterest += o.interest;
    if (o.total > 0n && i.dueDate < now) overdue += o.total;
  }

  // Before disbursement, show exactly what the schedule WILL be.
  let preview: ScheduleRow[] | null = null;
  if (!hasSchedule && PREVIEW_STATUSES.includes(l.status)) {
    try {
      preview = computeSchedule(termsOf(l));
    } catch {
      preview = null;
    }
  }
  const totalRepayable = hasSchedule ? due : (l.totalRepayablePaise ?? (preview ? sumTotals(preview) : null));
  const next = insts.find((i) => i.paidPaise < i.totalDuePaise);

  return {
    id: l.id,
    groupId: l.groupId,
    borrower: { userId: l.userId, name: l.user.name },
    principalPaise: paiseToNumber(l.principalPaise),
    purpose: l.purpose,
    installmentCount: l.installmentCount,
    repaymentFrequency: l.repaymentFrequency,
    interestMethod: l.interestMethod,
    interestRateBps: l.interestRateBps,
    policy: policyText(l.interestMethod, l.interestRateBps, l.repaymentFrequency),
    status: l.status,
    totalRepayablePaise: totalRepayable === null ? null : paiseToNumber(totalRepayable),
    totalInterestPaise: totalRepayable === null ? null : paiseToNumber(totalRepayable - l.principalPaise),
    paidPaise: hasSchedule ? paiseToNumber(paid) : 0,
    outstandingPaise: hasSchedule ? paiseToNumber(outPrincipal + outInterest) : null,
    outstandingPrincipalPaise: hasSchedule ? paiseToNumber(outPrincipal) : null,
    overdueAmountPaise: paiseToNumber(overdue),
    nextDue: next
      ? { number: next.number, dueDate: next.dueDate, remainingPaise: paiseToNumber(outstanding(next).total) }
      : null,
    requestedAt: l.requestedAt,
    reviewedAt: l.reviewedAt,
    approvedAt: l.approvedAt,
    approvedBy: l.approvedBy?.name ?? null,
    rejectionReason: l.rejectionReason,
    disbursedAt: l.disbursedAt,
    disbursedBy: l.disbursedBy?.name ?? null,
    disbursementRef: l.disbursementRef,
    firstDueDate: l.firstDueDate,
    schedulePreview: preview ? preview.map(rowOut) : null,
    ...(withInstallments ? { installments: insts.map((i) => serializeInstallment(i, now)) } : {}),
  };
}

function assertCanView(loan: { userId: string }, viewer: Viewer) {
  if (!can(viewer.role, "loan:view_all") && loan.userId !== viewer.userId) throw notFound();
}

// ───────────── statuses and overdue handling ─────────────

// Brings installment and loan statuses in line with payments and the clock.
// Call inside a transaction that holds the group lock.
export async function refreshLoanStatus(
  tx: Tx,
  loan: { id: string; status: LoanStatus },
  insts: LoanInstallment[],
  now: Date
): Promise<LoanStatus> {
  for (const i of insts) {
    const s = deriveInstallmentStatus(i, now);
    if (s !== i.status) await tx.loanInstallment.update({ where: { id: i.id }, data: { status: s } });
  }
  const status = deriveLoanStatus(insts, now);
  if (status !== loan.status) await tx.loan.update({ where: { id: loan.id }, data: { status } });
  return status;
}

// Cheap for a 10 to 20 member group. Runs whenever loans are read; a script can also run it daily.
export async function syncGroupLoans(groupId: string, now = new Date()): Promise<void> {
  const live = await prisma.loan.count({ where: { groupId, status: { in: LIVE_STATUSES } } });
  if (live === 0) return;
  await prisma.$transaction(async (tx) => {
    await lockGroup(tx, groupId); // so a stale read can't overwrite a payment that just committed
    const loans = await tx.loan.findMany({
      where: { groupId, status: { in: LIVE_STATUSES } },
      include: { installments: true },
    });
    for (const l of loans) await refreshLoanStatus(tx, l, l.installments, now);
  });
}

// ───────────── who may decide ─────────────

async function borrowerRole(tx: Tx, groupId: string, userId: string): Promise<GroupRole> {
  const m = await tx.groupMember.findFirst({ where: { groupId, userId, status: "ACTIVE" }, select: { role: true } });
  return m?.role ?? "MEMBER";
}

// Nobody decides their own loan. The President decides everyone's, except their own,
// which the Vice President decides.
function assertCanDecide(actor: Actor, loanUserId: string, role: GroupRole, verb: string) {
  if (actor.id === loanUserId) {
    throw new AppError(403, "CANNOT_DECIDE_OWN_LOAN", `You can't ${verb} your own loan.`);
  }
  const needed: GroupRole = role === "PRESIDENT" ? "VICE_PRESIDENT" : "PRESIDENT";
  if (actor.role !== needed) {
    throw new AppError(
      403,
      "FORBIDDEN",
      needed === "VICE_PRESIDENT"
        ? "The President's own loans must be decided by the Vice President. Appoint a Vice President if there isn't one."
        : "Only the President can decide loans."
    );
  }
}

async function findLoanOrThrow(tx: Tx, groupId: string, loanId: string) {
  const loan = await tx.loan.findFirst({ where: { id: loanId, groupId } }); // groupId = tenant isolation
  if (!loan) throw notFound();
  return loan;
}

const defaultCount = (months: number, f: "WEEKLY" | "MONTHLY") =>
  f === "MONTHLY" ? Math.min(months, 60) : Math.min(months * 4, 156);

// ───────────── applying, reviewing, deciding ─────────────

export async function applyForLoan(
  groupId: string,
  user: { id: string; name: string },
  input: ApplyLoanInput,
  meta: RequestMeta
): Promise<{ replayed: boolean; loanId: string }> {
  return prisma.$transaction(async (tx) => {
    await lockGroup(tx, groupId);
    const group = await tx.group.findUniqueOrThrow({
      where: { id: groupId },
      select: { interestMethod: true, interestRateBps: true, defaultRepaymentMonths: true },
    });
    const principal = BigInt(input.principalPaise);

    const open = await tx.loan.findFirst({
      where: { groupId, userId: user.id, status: { notIn: ["REJECTED", "COMPLETED"] } },
    });
    if (open) {
      // A double-click: the same application a moment ago. Return it instead of an error.
      const justNow = Date.now() - open.createdAt.getTime() < 60_000;
      if (justNow && open.status === "PENDING" && open.principalPaise === principal && open.purpose === input.purpose) {
        return { replayed: true, loanId: open.id };
      }
      throw new AppError(
        409,
        "HAS_OPEN_LOAN",
        "You already have a loan that isn't completed. Finish or withdraw it before applying for another."
      );
    }

    const frequency = input.repaymentFrequency ?? "MONTHLY";
    const terms: LoanTerms = {
      principalPaise: principal,
      installmentCount: input.installmentCount ?? defaultCount(group.defaultRepaymentMonths, frequency),
      repaymentFrequency: frequency,
      interestMethod: group.interestMethod, // frozen from the group's policy
      interestRateBps: group.interestRateBps,
    };
    const schedule = scheduleOrThrow(terms); // rejects impossible terms up front

    const loan = await tx.loan.create({
      data: {
        groupId,
        userId: user.id,
        purpose: input.purpose,
        principalPaise: terms.principalPaise,
        installmentCount: terms.installmentCount,
        repaymentFrequency: terms.repaymentFrequency,
        interestMethod: terms.interestMethod,
        interestRateBps: terms.interestRateBps,
      },
    });

    const admins = await tx.groupMember.findMany({
      where: { groupId, status: "ACTIVE", role: { in: ["PRESIDENT", "VICE_PRESIDENT"] }, userId: { not: user.id } },
      select: { userId: true },
    });
    if (admins.length > 0) {
      await tx.notification.createMany({
        data: admins.map((a) => ({
          userId: a.userId,
          groupId,
          type: "LOAN_APPLIED",
          title: "New loan application",
          body: `${user.name} applied for ${formatRupees(principal)}.`,
        })),
      });
    }
    await audit(
      {
        actorId: user.id,
        groupId,
        action: "LOAN_APPLIED",
        entityType: "Loan",
        entityId: loan.id,
        after: {
          principalPaise: input.principalPaise,
          installmentCount: terms.installmentCount,
          repaymentFrequency: frequency,
          interestMethod: terms.interestMethod,
          interestRateBps: terms.interestRateBps,
          totalRepayablePaise: paiseToNumber(sumTotals(schedule)),
        },
        ip: meta.ip,
        userAgent: meta.userAgent,
      },
      tx
    );
    return { replayed: false, loanId: loan.id };
  });
}

export async function reviewLoan(
  groupId: string,
  loanId: string,
  actor: Actor,
  note: string | undefined,
  meta: RequestMeta
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await lockGroup(tx, groupId);
    const loan = await findLoanOrThrow(tx, groupId, loanId);
    if (loan.userId === actor.id) {
      throw new AppError(403, "CANNOT_REVIEW_OWN_LOAN", "You can't review your own loan.");
    }
    if (loan.status === "UNDER_REVIEW") return; // already done: harmless repeat
    if (loan.status !== "PENDING") throw invalidState(loan.status, "reviewed");

    await tx.loan.update({ where: { id: loan.id }, data: { status: "UNDER_REVIEW", reviewedAt: new Date() } });
    await audit(
      {
        actorId: actor.id,
        groupId,
        action: "LOAN_REVIEWED",
        entityType: "Loan",
        entityId: loan.id,
        after: { note: note ?? null },
        ip: meta.ip,
        userAgent: meta.userAgent,
      },
      tx
    );
  });
}

export async function approveLoan(
  groupId: string,
  loanId: string,
  actor: Actor,
  note: string | undefined,
  meta: RequestMeta
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await lockGroup(tx, groupId);
    const loan = await findLoanOrThrow(tx, groupId, loanId);
    assertCanDecide(actor, loan.userId, await borrowerRole(tx, groupId, loan.userId), "approve");
    if (loan.status !== "PENDING" && loan.status !== "UNDER_REVIEW") throw invalidState(loan.status, "approved");

    const schedule = scheduleOrThrow(termsOf(loan));
    const total = sumTotals(schedule);

    // Money already promised to other approved (not yet disbursed) loans isn't available.
    const fund = await groupFundBalance(tx, groupId);
    const committed =
      (await tx.loan.aggregate({ _sum: { principalPaise: true }, where: { groupId, status: "APPROVED" } }))._sum
        .principalPaise ?? 0n;
    const available = fund - committed;
    if (loan.principalPaise > available) {
      throw new AppError(
        409,
        "INSUFFICIENT_FUND",
        `The fund available for new loans is ${formatRupees(available)} (after other approved loans), which can't cover ${formatRupees(loan.principalPaise)}.`
      );
    }

    const now = new Date();
    await tx.loan.update({
      where: { id: loan.id },
      data: {
        status: "APPROVED",
        approvedById: actor.id,
        approvedAt: now,
        reviewedAt: loan.reviewedAt ?? now,
        totalRepayablePaise: total,
      },
    });
    await tx.notification.create({
      data: {
        userId: loan.userId,
        groupId,
        type: "LOAN_APPROVED",
        title: "Your loan was approved",
        body: `${actor.name} approved ${formatRupees(loan.principalPaise)}. You'll repay ${formatRupees(total)} in total. The money is sent when the President disburses it.`,
      },
    });
    await audit(
      {
        actorId: actor.id,
        groupId,
        action: "LOAN_APPROVED",
        entityType: "Loan",
        entityId: loan.id,
        before: { status: loan.status },
        after: {
          status: "APPROVED",
          principalPaise: paiseToNumber(loan.principalPaise),
          totalRepayablePaise: paiseToNumber(total),
          interestMethod: loan.interestMethod,
          interestRateBps: loan.interestRateBps,
          note: note ?? null,
        },
        ip: meta.ip,
        userAgent: meta.userAgent,
      },
      tx
    );
  });
}

export async function rejectLoan(
  groupId: string,
  loanId: string,
  actor: Actor,
  reason: string,
  meta: RequestMeta
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await lockGroup(tx, groupId);
    const loan = await findLoanOrThrow(tx, groupId, loanId);
    assertCanDecide(actor, loan.userId, await borrowerRole(tx, groupId, loan.userId), "reject");
    if (!["PENDING", "UNDER_REVIEW", "APPROVED"].includes(loan.status)) throw invalidState(loan.status, "rejected");

    await tx.loan.update({
      where: { id: loan.id },
      data: { status: "REJECTED", rejectionReason: reason, reviewedAt: loan.reviewedAt ?? new Date() },
    });
    await tx.notification.create({
      data: {
        userId: loan.userId,
        groupId,
        type: "LOAN_REJECTED",
        title: "Your loan was not approved",
        body: `${actor.name} rejected your application. Reason: ${reason}`,
      },
    });
    await audit(
      {
        actorId: actor.id,
        groupId,
        action: "LOAN_REJECTED",
        entityType: "Loan",
        entityId: loan.id,
        before: { status: loan.status },
        after: { status: "REJECTED", reason },
        ip: meta.ip,
        userAgent: meta.userAgent,
      },
      tx
    );
  });
}

// The applicant withdraws before any money moves. Shows as REJECTED with a clear reason.
export async function cancelLoan(groupId: string, loanId: string, actor: Actor, meta: RequestMeta): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await lockGroup(tx, groupId);
    const loan = await tx.loan.findFirst({ where: { id: loanId, groupId } });
    if (!loan || loan.userId !== actor.id) throw notFound(); // not yours: looks like it doesn't exist
    if (!["PENDING", "UNDER_REVIEW", "APPROVED"].includes(loan.status)) throw invalidState(loan.status, "withdrawn");

    await tx.loan.update({
      where: { id: loan.id },
      data: { status: "REJECTED", rejectionReason: "Withdrawn by the applicant." },
    });
    await audit(
      {
        actorId: actor.id,
        groupId,
        action: "LOAN_WITHDRAWN",
        entityType: "Loan",
        entityId: loan.id,
        before: { status: loan.status },
        after: { status: "REJECTED" },
        ip: meta.ip,
        userAgent: meta.userAgent,
      },
      tx
    );
  });
}

// ───────────── disbursement ─────────────

// Records that a REAL transfer was made (with its reference). The app moves no money.
export async function disburseLoan(
  groupId: string,
  loanId: string,
  actor: Actor,
  input: DisburseInput,
  meta: RequestMeta
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await lockGroup(tx, groupId);
    const loan = await tx.loan.findFirst({ where: { id: loanId, groupId }, include: { user: { select: { name: true } } } });
    if (!loan) throw notFound();
    assertCanDecide(actor, loan.userId, await borrowerRole(tx, groupId, loan.userId), "disburse");
    if (loan.status !== "APPROVED") {
      throw loan.disbursedAt
        ? new AppError(409, "ALREADY_DISBURSED", "This loan was already disbursed.")
        : invalidState(loan.status, "disbursed (it must be approved first)");
    }

    const fund = await groupFundBalance(tx, groupId);
    if (fund < loan.principalPaise) {
      throw new AppError(
        409,
        "INSUFFICIENT_FUND",
        `The group fund (${formatRupees(fund)}) can't cover ${formatRupees(loan.principalPaise)}.`
      );
    }

    // The schedule is deterministic from the frozen terms. If it ever differs from what was approved, stop.
    const schedule = scheduleOrThrow(termsOf(loan));
    if (loan.totalRepayablePaise !== null && sumTotals(schedule) !== loan.totalRepayablePaise) {
      throw new Error(`Schedule for loan ${loan.id} no longer matches the approved total`);
    }

    const now = new Date();
    const dueDates = schedule.map((r) => installmentDueDate(now, r.number, loan.repaymentFrequency));
    await tx.loanInstallment.createMany({
      data: schedule.map((r, idx) => ({
        loanId: loan.id,
        groupId,
        number: r.number,
        dueDate: dueDates[idx],
        principalPaise: r.principalPaise,
        interestPaise: r.interestPaise,
        totalDuePaise: r.totalPaise,
      })),
    });

    // Ledger: the member now owes the group the principal; the group's cash goes down.
    await ensureMemberAccounts(tx, groupId, loan.userId);
    const receivable = await getAccountId(tx, groupId, "LOANS_RECEIVABLE", loan.userId);
    const bank = await getAccountId(tx, groupId, "BANK_CLEARING");
    const ref = input.reference?.toUpperCase();
    const { journal } = await postJournal(tx, {
      groupId,
      type: "LOAN_DISBURSEMENT",
      description: `Loan disbursed to ${loan.user.name} (${input.method}${ref ? ` ${ref}` : ""})`,
      createdById: actor.id,
      approvedById: loan.approvedById ?? undefined,
      loanId: loan.id,
      idempotencyKey: `loan-disburse:${loan.id}`,
      lines: [
        { accountId: receivable, direction: "DEBIT", amountPaise: loan.principalPaise },
        { accountId: bank, direction: "CREDIT", amountPaise: loan.principalPaise },
      ],
    });

    await tx.loan.update({
      where: { id: loan.id },
      data: {
        status: "DISBURSED",
        disbursedById: actor.id,
        disbursedAt: now,
        disbursementRef: ref ?? "CASH",
        firstDueDate: dueDates[0],
      },
    });
    await tx.notification.create({
      data: {
        userId: loan.userId,
        groupId,
        type: "LOAN_DISBURSED",
        title: "Your loan was disbursed",
        body: `${formatRupees(loan.principalPaise)} was recorded as sent to you. Your first installment is due on ${dueDates[0].toISOString().slice(0, 10)}.`,
      },
    });
    await audit(
      {
        actorId: actor.id,
        groupId,
        action: "LOAN_DISBURSED",
        entityType: "Loan",
        entityId: loan.id,
        after: {
          principalPaise: paiseToNumber(loan.principalPaise),
          method: input.method,
          reference: ref ?? null,
          note: input.note,
          journalId: journal.id,
          firstDueDate: dueDates[0].toISOString(),
        },
        ip: meta.ip,
        userAgent: meta.userAgent,
      },
      tx
    );
  });
}

// ───────────── reading ─────────────

export async function getLoan(groupId: string, loanId: string, viewer: Viewer) {
  await syncGroupLoans(groupId);
  const loan = await prisma.loan.findFirst({ where: { id: loanId, groupId }, include: loanInclude });
  if (!loan) throw notFound();
  assertCanView(loan, viewer);
  return serializeLoan(loan, new Date());
}

export async function listLoans(groupId: string, viewer: Viewer, q: LoanListQuery) {
  await syncGroupLoans(groupId);
  const admin = can(viewer.role, "loan:view_all");
  const where: Prisma.LoanWhereInput = {
    groupId,
    ...(admin ? {} : { userId: viewer.userId }),
    ...(q.status ? { status: q.status } : {}),
  };
  const [total, rows] = await prisma.$transaction([
    prisma.loan.count({ where }),
    prisma.loan.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      include: loanInclude,
    }),
  ]);
  const now = new Date();
  return { page: q.page, pageSize: q.pageSize, total, items: rows.map((l) => serializeLoan(l, now, false)) };
}

export async function listRepayments(groupId: string, loanId: string, viewer: Viewer) {
  const loan = await prisma.loan.findFirst({ where: { id: loanId, groupId }, select: { userId: true } });
  if (!loan) throw notFound();
  assertCanView(loan, viewer);
  const rows = await prisma.loanRepayment.findMany({
    where: { loanId, groupId },
    orderBy: { paidAt: "asc" },
    include: {
      installment: { select: { number: true } },
      paymentTransaction: { select: { method: true, providerPaymentId: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    installmentNumber: r.installment?.number ?? null,
    amountPaise: paiseToNumber(r.amountPaise),
    principalPortionPaise: paiseToNumber(r.principalPortionPaise),
    interestPortionPaise: paiseToNumber(r.interestPortionPaise),
    method: r.paymentTransaction?.method ?? null,
    paidAt: r.paidAt,
  }));
}

// "What would I repay?" for the application form. Uses the group's CURRENT policy.
export async function quoteLoan(groupId: string, q: QuoteQuery) {
  const group = await prisma.group.findUniqueOrThrow({
    where: { id: groupId },
    select: { interestMethod: true, interestRateBps: true, defaultRepaymentMonths: true },
  });
  const frequency = q.repaymentFrequency ?? "MONTHLY";
  const installmentCount = q.installmentCount ?? defaultCount(group.defaultRepaymentMonths, frequency);
  const rows = scheduleOrThrow({
    principalPaise: BigInt(q.principalPaise),
    installmentCount,
    repaymentFrequency: frequency,
    interestMethod: group.interestMethod,
    interestRateBps: group.interestRateBps,
  });
  const total = sumTotals(rows);
  return {
    policy: policyText(group.interestMethod, group.interestRateBps, frequency),
    interestMethod: group.interestMethod,
    interestRateBps: group.interestRateBps,
    installmentCount,
    repaymentFrequency: frequency,
    principalPaise: q.principalPaise,
    totalInterestPaise: paiseToNumber(total - BigInt(q.principalPaise)),
    totalRepayablePaise: paiseToNumber(total),
    installments: rows.map(rowOut),
    note: "The terms are fixed when you apply, using the group's policy at that moment.",
  };
}

// President / VP: what is out there and what is late.
export async function outstandingReport(groupId: string) {
  await syncGroupLoans(groupId);
  const now = new Date();
  const [loans, disbursed, repaid] = await Promise.all([
    prisma.loan.findMany({
      where: { groupId, status: { in: LIVE_STATUSES } },
      include: loanInclude,
      orderBy: { disbursedAt: "asc" },
    }),
    prisma.loan.aggregate({ _sum: { principalPaise: true }, where: { groupId, disbursedAt: { not: null } } }),
    prisma.loanRepayment.aggregate({
      _sum: { amountPaise: true, principalPortionPaise: true, interestPortionPaise: true },
      where: { groupId },
    }),
  ]);
  const items = loans.map((l) => serializeLoan(l, now, false));
  const sum = (pick: (i: (typeof items)[number]) => number | null) => items.reduce((s, i) => s + (pick(i) ?? 0), 0);
  return {
    summary: {
      loansDisbursedPaise: paiseToNumber(disbursed._sum.principalPaise ?? 0n),
      repaidPaise: paiseToNumber(repaid._sum.amountPaise ?? 0n),
      principalRepaidPaise: paiseToNumber(repaid._sum.principalPortionPaise ?? 0n),
      interestEarnedPaise: paiseToNumber(repaid._sum.interestPortionPaise ?? 0n),
      outstandingPrincipalPaise: sum((i) => i.outstandingPrincipalPaise),
      outstandingTotalPaise: sum((i) => i.outstandingPaise),
      overduePaise: sum((i) => i.overdueAmountPaise),
      activeLoans: items.length,
      overdueLoans: items.filter((i) => i.status === "OVERDUE").length,
    },
    items,
  };
}
