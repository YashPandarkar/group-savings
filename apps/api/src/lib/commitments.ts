import type { LoanStatus } from "@prisma/client";
import type { Db } from "./ledger";
import { outstanding } from "./loanRules";

const LIVE: LoanStatus[] = ["DISBURSED", "ACTIVE", "PARTIALLY_PAID", "OVERDUE"];

// Money already PROMISED but not yet sent: approved loans and approved withdrawals.
// Both approval paths subtract this from the fund so the same money can't be promised twice.
export async function committedFunds(db: Db, groupId: string, excludeWithdrawalId?: string): Promise<bigint> {
  const loans = await db.loan.aggregate({
    _sum: { principalPaise: true },
    where: { groupId, status: "APPROVED" },
  });
  const withdrawals = await db.withdrawal.aggregate({
    _sum: { amountPaise: true },
    where: { groupId, status: "APPROVED", ...(excludeWithdrawalId ? { id: { not: excludeWithdrawalId } } : {}) },
  });
  return (loans._sum.principalPaise ?? 0n) + (withdrawals._sum.amountPaise ?? 0n);
}

// Approved-but-unpaid withdrawals for ONE beneficiary (null = group expenses).
export async function reservedWithdrawals(
  db: Db,
  groupId: string,
  beneficiaryId: string | null,
  excludeWithdrawalId?: string
): Promise<bigint> {
  const r = await db.withdrawal.aggregate({
    _sum: { amountPaise: true },
    where: {
      groupId,
      status: "APPROVED",
      beneficiaryId,
      ...(excludeWithdrawalId ? { id: { not: excludeWithdrawalId } } : {}),
    },
  });
  return r._sum.amountPaise ?? 0n;
}

async function netBalance(db: Db, groupId: string, code: string, normal: "DEBIT" | "CREDIT"): Promise<bigint> {
  const where = { groupId, account: { code } };
  const d = await db.ledgerEntry.aggregate({ _sum: { amountPaise: true }, where: { ...where, direction: "DEBIT" } });
  const c = await db.ledgerEntry.aggregate({ _sum: { amountPaise: true }, where: { ...where, direction: "CREDIT" } });
  const debit = d._sum.amountPaise ?? 0n;
  const credit = c._sum.amountPaise ?? 0n;
  return normal === "CREDIT" ? credit - debit : debit - credit;
}

// What the group has EARNED beyond members' savings: interest income minus expenses already taken.
export async function groupSurplus(db: Db, groupId: string): Promise<bigint> {
  const income = await netBalance(db, groupId, "INTEREST_INCOME", "CREDIT");
  const expenses = await netBalance(db, groupId, "GROUP_EQUITY", "DEBIT");
  return income - expenses;
}

// Principal a member still owes on live loans. Their savings stand behind it.
export async function outstandingLoanPrincipal(db: Db, groupId: string, userId: string): Promise<bigint> {
  const loans = await db.loan.findMany({
    where: { groupId, userId, status: { in: LIVE } },
    include: { installments: true },
  });
  let total = 0n;
  for (const l of loans) for (const i of l.installments) total += outstanding(i).principal;
  return total;
}
