import type { LedgerAccountType, Prisma } from "@prisma/client";

type Tx = Prisma.TransactionClient;
type AccountDef = { code: string; type: LedgerAccountType; name: string };

// One set per group...
const GROUP_ACCOUNTS: AccountDef[] = [
  { code: "BANK_CLEARING", type: "ASSET", name: "Group bank (per records)" },
  { code: "INTEREST_INCOME", type: "INCOME", name: "Interest income" },
  { code: "GROUP_EQUITY", type: "EQUITY", name: "Group equity" },
];

// ...and one set per member.
const MEMBER_ACCOUNTS: AccountDef[] = [
  { code: "MEMBER_SAVINGS", type: "LIABILITY", name: "Member savings" },
  { code: "LOANS_RECEIVABLE", type: "ASSET", name: "Loans receivable" },
];

export async function ensureGroupAccounts(tx: Tx, groupId: string): Promise<void> {
  for (const def of GROUP_ACCOUNTS) {
    const found = await tx.ledgerAccount.findFirst({
      where: { groupId, code: def.code, userId: null },
      select: { id: true },
    });
    if (!found) {
      await tx.ledgerAccount.create({ data: { groupId, code: def.code, type: def.type, name: def.name } });
    }
  }
}

// Safe to call repeatedly (a member who leaves and re-joins keeps their accounts).
export async function ensureMemberAccounts(tx: Tx, groupId: string, userId: string): Promise<void> {
  for (const def of MEMBER_ACCOUNTS) {
    const found = await tx.ledgerAccount.findFirst({
      where: { groupId, code: def.code, userId },
      select: { id: true },
    });
    if (!found) {
      await tx.ledgerAccount.create({
        data: { groupId, code: def.code, type: def.type, name: def.name, userId },
      });
    }
  }
}

// How much of the group's money belongs to this member (credits minus debits).
// Computed from the ledger. We never store a balance that could drift.
export async function memberSavingsBalance(tx: Tx, groupId: string, userId: string): Promise<bigint> {
  const account = await tx.ledgerAccount.findFirst({
    where: { groupId, code: "MEMBER_SAVINGS", userId },
    select: { id: true },
  });
  if (!account) return 0n;

  const credits = await tx.ledgerEntry.aggregate({
    _sum: { amountPaise: true },
    where: { accountId: account.id, direction: "CREDIT" },
  });
  const debits = await tx.ledgerEntry.aggregate({
    _sum: { amountPaise: true },
    where: { accountId: account.id, direction: "DEBIT" },
  });
  return (credits._sum.amountPaise ?? 0n) - (debits._sum.amountPaise ?? 0n);
}
