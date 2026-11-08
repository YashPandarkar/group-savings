import type { EntryDirection, Prisma, TransactionType } from "@prisma/client";
import type { prisma } from "../config/prisma";

export type Tx = Prisma.TransactionClient;
export type Db = Tx | typeof prisma;

export type JournalLine = { accountId: string; direction: EntryDirection; amountPaise: bigint };

export type PostJournalInput = {
  groupId: string;
  type: TransactionType;
  description: string;
  createdById: string;
  approvedById?: string;
  paymentTransactionId?: string;
  loanId?: string;
  withdrawalId?: string;
  reversalOfId?: string;
  occurredAt?: Date;
  // If a journal with this key already exists in the group, it is returned instead of creating a new one.
  idempotencyKey?: string;
  lines: JournalLine[];
};

// THE ONLY way money enters the ledger. Must be called inside a database transaction.
// Two safety nets: this function checks the balance in code, and the database trigger
// from Phase 3 checks it again at COMMIT.
export async function postJournal(tx: Tx, input: PostJournalInput) {
  if (input.lines.length < 2) {
    throw new Error("A journal needs at least two entries (one debit and one credit).");
  }
  let debit = 0n;
  let credit = 0n;
  for (const line of input.lines) {
    if (line.amountPaise <= 0n) throw new Error("Journal entries must have a positive amount.");
    if (line.direction === "DEBIT") debit += line.amountPaise;
    else credit += line.amountPaise;
  }
  if (debit !== credit) {
    throw new Error(`Journal is unbalanced: debits=${debit} credits=${credit}`);
  }

  if (input.idempotencyKey) {
    const existing = await tx.ledgerJournal.findUnique({
      where: { groupId_idempotencyKey: { groupId: input.groupId, idempotencyKey: input.idempotencyKey } },
    });
    if (existing) return { journal: existing, replayed: true };
  }

  const journal = await tx.ledgerJournal.create({
    data: {
      groupId: input.groupId,
      type: input.type,
      description: input.description,
      createdById: input.createdById,
      approvedById: input.approvedById ?? null,
      paymentTransactionId: input.paymentTransactionId ?? null,
      loanId: input.loanId ?? null,
      withdrawalId: input.withdrawalId ?? null,
      reversalOfId: input.reversalOfId ?? null,
      occurredAt: input.occurredAt ?? new Date(),
      idempotencyKey: input.idempotencyKey ?? null,
    },
  });
  await tx.ledgerEntry.createMany({
    data: input.lines.map((l) => ({
      journalId: journal.id,
      groupId: input.groupId,
      accountId: l.accountId,
      direction: l.direction,
      amountPaise: l.amountPaise,
    })),
  });
  return { journal, replayed: false };
}

// Looks up an account created in Phase 5 (group-level when userId is omitted).
export async function getAccountId(db: Db, groupId: string, code: string, userId?: string): Promise<string> {
  const account = await db.ledgerAccount.findFirst({
    where: { groupId, code, userId: userId ?? null },
    select: { id: true },
  });
  if (!account) throw new Error(`Ledger account ${code} is missing for group ${groupId}`);
  return account.id;
}

// What the group's money is, PER OUR RECORDS (debits minus credits on BANK_CLEARING).
// This is not the bank balance: the two should be reconciled against a bank statement.
export async function groupFundBalance(db: Db, groupId: string): Promise<bigint> {
  const where = { groupId, account: { code: "BANK_CLEARING" } };
  const debits = await db.ledgerEntry.aggregate({ _sum: { amountPaise: true }, where: { ...where, direction: "DEBIT" } });
  const credits = await db.ledgerEntry.aggregate({ _sum: { amountPaise: true }, where: { ...where, direction: "CREDIT" } });
  return (debits._sum.amountPaise ?? 0n) - (credits._sum.amountPaise ?? 0n);
}
