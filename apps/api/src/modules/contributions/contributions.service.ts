import type { Contribution } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { AppError } from "../../lib/errors";
import { paiseToNumber } from "../../lib/money";
import { dueDateFor, periodOf } from "../../lib/period";
import type { Db } from "../../lib/ledger";

// Creates this month's contribution row for every eligible member.
// Safe to call any number of times, even concurrently: the unique index on
// (group, user, year, month) plus skipDuplicates means "insert if missing".
// Eligible = ACTIVE and joined on or before the due date.
export async function ensureContributions(db: Db, groupId: string, year: number, month: number): Promise<number> {
  const group = await db.group.findUniqueOrThrow({
    where: { id: groupId },
    select: { monthlyContributionPaise: true, contributionDueDay: true },
  });
  const dueDate = dueDateFor(year, month, group.contributionDueDay);
  const members = await db.groupMember.findMany({
    where: { groupId, status: "ACTIVE", joinedAt: { lte: dueDate } },
    select: { userId: true },
  });
  if (members.length === 0) return 0;

  const result = await db.contribution.createMany({
    data: members.map((m) => ({
      groupId,
      userId: m.userId,
      periodYear: year,
      periodMonth: month,
      dueDate,
      expectedPaise: group.monthlyContributionPaise,
    })),
    skipDuplicates: true,
  });
  return result.count;
}

async function ensureCurrent(groupId: string) {
  const current = periodOf(new Date());
  await ensureContributions(prisma, groupId, current.year, current.month);
  return current;
}

export function serializeContribution(c: Contribution, now = new Date()) {
  const remaining = c.expectedPaise > c.paidPaise ? c.expectedPaise - c.paidPaise : 0n;
  const open = c.status === "PENDING" || c.status === "PARTIAL";
  return {
    id: c.id,
    userId: c.userId,
    periodYear: c.periodYear,
    periodMonth: c.periodMonth,
    dueDate: c.dueDate,
    expectedPaise: paiseToNumber(c.expectedPaise),
    paidPaise: paiseToNumber(c.paidPaise),
    remainingPaise: paiseToNumber(remaining),
    status: c.status,
    // Computed from the clock, so there is no "late" flag to keep in sync.
    overdue: open && c.dueDate < now,
    paidLate: c.status === "PAID" && c.paidAt !== null && c.paidAt > c.dueDate,
    paidAt: c.paidAt,
  };
}

// The monthly collection dashboard (President and VP).
export async function getPeriodOverview(groupId: string, year?: number, month?: number) {
  const current = periodOf(new Date());
  const y = year ?? current.year;
  const m = month ?? current.month;
  if (y === current.year && m === current.month) await ensureContributions(prisma, groupId, y, m);

  const rows = await prisma.contribution.findMany({
    where: {
      groupId,
      periodYear: y,
      periodMonth: m,
      // Only people still in the group count toward "expected".
      user: { memberships: { some: { groupId, status: "ACTIVE" } } },
    },
    include: { user: { select: { name: true } } },
    orderBy: { user: { name: "asc" } },
  });

  const now = new Date();
  let expected = 0n;
  let collected = 0n;
  let pending = 0n;
  const counts = { paid: 0, partial: 0, pending: 0, overdue: 0, waived: 0 };

  for (const r of rows) {
    if (r.status === "WAIVED") {
      counts.waived++;
      continue;
    }
    expected += r.expectedPaise;
    collected += r.paidPaise;
    pending += r.expectedPaise > r.paidPaise ? r.expectedPaise - r.paidPaise : 0n;
    if (r.status === "PAID") counts.paid++;
    else if (r.status === "PARTIAL") counts.partial++;
    else counts.pending++;
    if ((r.status === "PENDING" || r.status === "PARTIAL") && r.dueDate < now) counts.overdue++;
  }

  return {
    period: { year: y, month: m },
    summary: {
      expectedPaise: paiseToNumber(expected),
      collectedPaise: paiseToNumber(collected),
      pendingPaise: paiseToNumber(pending),
      counts,
    },
    items: rows.map((r) => ({ ...serializeContribution(r, now), memberName: r.user.name })),
  };
}

// A member's own history (newest first).
export async function getHistoryForUser(groupId: string, userId: string) {
  await ensureCurrent(groupId);
  const rows = await prisma.contribution.findMany({
    where: { groupId, userId }, // groupId in the query = tenant isolation
    orderBy: [{ periodYear: "desc" }, { periodMonth: "desc" }],
    take: 60,
  });
  const now = new Date();
  return rows.map((r) => serializeContribution(r, now));
}

// Same, but looked up by membership id (for the President / VP member-detail page).
export async function getHistoryForMembership(groupId: string, membershipId: string) {
  const membership = await prisma.groupMember.findFirst({
    where: { id: membershipId, groupId },
    include: { user: { select: { name: true } } },
  });
  if (!membership) throw new AppError(404, "MEMBER_NOT_FOUND", "Member not found.");
  return {
    member: { id: membership.id, userId: membership.userId, name: membership.user.name, status: membership.status },
    items: await getHistoryForUser(groupId, membership.userId),
  };
}
