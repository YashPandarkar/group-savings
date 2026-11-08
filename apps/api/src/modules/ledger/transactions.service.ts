import type { GroupRole, Prisma } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { AppError } from "../../lib/errors";
import { audit } from "../../lib/audit";
import { can } from "../../lib/permissions";
import { paiseToNumber, rupeesPlain } from "../../lib/money";
import { csvRaw, csvRow, csvText } from "../../lib/csv";
import { groupFundBalance } from "../../lib/ledger";
import { memberSavingsBalance } from "../../lib/ledgerAccounts";
import type { RequestMeta } from "../auth/auth.service";
import type { TxListQuery } from "./ledger.schema";

type Tx = Prisma.TransactionClient;
type Viewer = { userId: string; role: GroupRole };

const IST = "+05:30";
const EXPORT_LIMIT = 5000;

const journalInclude = {
  entries: {
    include: { account: { select: { code: true, userId: true, user: { select: { name: true } } } } },
  },
  createdBy: { select: { name: true } },
  approvedBy: { select: { name: true } },
  paymentTransaction: {
    select: { method: true, status: true, providerPaymentId: true, evidenceNote: true },
  },
  reversal: { select: { id: true } }, // the journal that reversed THIS one (if any)
} satisfies Prisma.LedgerJournalInclude;

type JournalRow = Prisma.LedgerJournalGetPayload<{ include: typeof journalInclude }>;

// Group balance after each journal, in time order. One pass in SQL (a window function).
async function runningBalances(db: Tx, groupId: string): Promise<Map<string, bigint>> {
  const rows = await db.$queryRaw<{ id: string; balance: bigint }[]>`
    SELECT j.id,
           (SUM(j.delta) OVER (ORDER BY j."occurredAt", j."createdAt", j.id))::bigint AS balance
    FROM (
      SELECT lj.id, lj."occurredAt", lj."createdAt",
             COALESCE(SUM(CASE WHEN a.code = 'BANK_CLEARING'
                               THEN CASE WHEN e.direction = 'DEBIT' THEN e."amountPaise" ELSE -e."amountPaise" END
                          END), 0) AS delta
      FROM ledger_journals lj
      JOIN ledger_entries e ON e."journalId" = lj.id
      JOIN ledger_accounts a ON a.id = e."accountId"
      WHERE lj."groupId" = ${groupId}
      GROUP BY lj.id, lj."occurredAt", lj."createdAt"
    ) j
  `;
  return new Map(rows.map((r) => [r.id, r.balance]));
}

const referenceOf = (id: string | null | undefined) =>
  id?.startsWith("manual:") ? id.split(":").slice(2).join(":") : (id ?? null);

function serialize(j: JournalRow, opts: { admin: boolean; balance?: bigint }) {
  let debitTotal = 0n;
  let bankDelta = 0n;
  let member: { userId: string; name: string } | null = null;
  for (const e of j.entries) {
    if (e.direction === "DEBIT") debitTotal += e.amountPaise;
    if (e.account.code === "BANK_CLEARING") {
      bankDelta += e.direction === "DEBIT" ? e.amountPaise : -e.amountPaise;
    }
    if (!member && e.account.userId) {
      member = { userId: e.account.userId, name: e.account.user?.name ?? "Unknown" };
    }
  }
  const pt = j.paymentTransaction;
  return {
    id: j.id,
    occurredAt: j.occurredAt,
    type: j.type,
    description: j.description,
    memberUserId: member?.userId ?? null,
    memberName: member?.name ?? null,
    amountPaise: paiseToNumber(debitTotal),
    // +ve = money in per the group's records, -ve = money out, 0 = no cash effect
    bankDeltaPaise: paiseToNumber(bankDelta),
    status: j.type === "REVERSAL" ? "REVERSAL" : j.reversal ? "REVERSED" : "POSTED",
    reversalOfId: j.reversalOfId,
    reversedById: j.reversal?.id ?? null,
    method: pt?.method ?? null,
    paymentStatus: pt?.status ?? null,
    reference: referenceOf(pt?.providerPaymentId),
    recordedBy: j.createdBy.name,
    approvedBy: j.approvedBy?.name ?? null,
    ...(opts.admin
      ? {
          evidenceNote: pt?.evidenceNote ?? null,
          balanceAfterPaise: opts.balance === undefined ? null : paiseToNumber(opts.balance),
        }
      : {}),
  };
}

// "2026-11-08" -> the start / end of that day in India
const istStart = (d: string) => new Date(`${d}T00:00:00.000${IST}`);
const istEnd = (d: string) => new Date(`${d}T23:59:59.999${IST}`);

function buildWhere(groupId: string, viewerUserId: string, admin: boolean, q: TxListQuery) {
  const and: Prisma.LedgerJournalWhereInput[] = [];

  // Tenant isolation is the groupId below. Members are further limited to their own accounts.
  if (!admin) and.push({ entries: { some: { account: { userId: viewerUserId } } } });
  else if (q.memberUserId) and.push({ entries: { some: { account: { userId: q.memberUserId } } } });

  if (q.type) and.push({ type: q.type });
  if (q.from) and.push({ occurredAt: { gte: istStart(q.from) } });
  if (q.to) and.push({ occurredAt: { lte: istEnd(q.to) } });
  if (q.status === "REVERSED") and.push({ reversal: { isNot: null } });
  if (q.status === "REVERSAL") and.push({ type: "REVERSAL" });
  if (q.status === "POSTED") and.push({ type: { not: "REVERSAL" }, reversal: { is: null } });
  if (q.paymentStatus) and.push({ paymentTransaction: { is: { status: q.paymentStatus } } });
  if (q.q) {
    and.push({
      OR: [
        { id: { startsWith: q.q.toLowerCase() } },
        { entries: { some: { account: { user: { is: { name: { contains: q.q, mode: "insensitive" } } } } } } },
      ],
    });
  }
  return { groupId, AND: and } satisfies Prisma.LedgerJournalWhereInput;
}

async function fetchJournals(groupId: string, viewer: Viewer, q: TxListQuery, skip: number, take: number) {
  const admin = can(viewer.role, "transactions:view_all");
  const where = buildWhere(groupId, viewer.userId, admin, q);
  const dir = q.sort === "date_asc" ? "asc" : "desc";
  const [total, rows] = await prisma.$transaction([
    prisma.ledgerJournal.count({ where }),
    prisma.ledgerJournal.findMany({
      where,
      orderBy: [{ occurredAt: dir }, { createdAt: dir }, { id: dir }],
      skip,
      take,
      include: journalInclude,
    }),
  ]);
  const balances = admin ? await runningBalances(prisma, groupId) : null;
  return { admin, total, rows, balances };
}

export async function listTransactions(groupId: string, viewer: Viewer, q: TxListQuery) {
  const { admin, total, rows, balances } = await fetchJournals(
    groupId, viewer, q, (q.page - 1) * q.pageSize, q.pageSize
  );
  return {
    page: q.page,
    pageSize: q.pageSize,
    total,
    items: rows.map((r) => serialize(r, { admin, balance: balances?.get(r.id) })),
  };
}

export async function getTransaction(groupId: string, id: string, viewer: Viewer) {
  const admin = can(viewer.role, "transactions:view_all");
  const j = await prisma.ledgerJournal.findFirst({ where: { id, groupId }, include: journalInclude });
  // 404 (not 403) for other people's transactions: don't reveal that they exist.
  if (!j || (!admin && !j.entries.some((e) => e.account.userId === viewer.userId))) {
    throw new AppError(404, "TRANSACTION_NOT_FOUND", "Transaction not found.");
  }
  const balances = admin ? await runningBalances(prisma, groupId) : null;
  return {
    transaction: serialize(j, { admin, balance: balances?.get(j.id) }),
    lines: j.entries.map((e) => ({
      account: e.account.code,
      memberName: e.account.user?.name ?? null,
      direction: e.direction,
      amountPaise: paiseToNumber(e.amountPaise),
    })),
  };
}

// What the group's records say, plus the caller's own savings. NOT a bank balance.
export async function getSummary(groupId: string, userId: string) {
  const [fund, mine] = await Promise.all([
    groupFundBalance(prisma, groupId),
    memberSavingsBalance(prisma, groupId, userId),
  ]);
  return {
    basis: "RECORDS",
    note: "Calculated from the group's ledger. It is not a bank balance: compare it with the bank statement.",
    fundBalancePaise: paiseToNumber(fund),
    mySavingsPaise: paiseToNumber(mine),
  };
}

const istStamp = (d: Date) =>
  new Date(d.getTime() + 330 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19) + " IST";

export async function exportCsv(groupId: string, viewer: Viewer, q: TxListQuery, meta: RequestMeta) {
  const { admin, rows, balances } = await fetchJournals(groupId, viewer, q, 0, EXPORT_LIMIT);

  const header = [
    "Transaction ID", "Date", "Member", "Type", "Direction", "Amount (INR)", "Status",
    "Payment method", "Payment status", "Reference", "Description", "Recorded by",
    ...(admin ? ["Group balance after (INR)"] : []),
  ];
  const lines = [csvRow(header.map(csvRaw))];

  for (const r of rows) {
    const t = serialize(r, { admin, balance: balances?.get(r.id) });
    const direction = t.bankDeltaPaise > 0 ? "IN" : t.bankDeltaPaise < 0 ? "OUT" : "-";
    const balance = admin && t.balanceAfterPaise !== null && t.balanceAfterPaise !== undefined
      ? rupeesPlain(BigInt(t.balanceAfterPaise))
      : "";
    lines.push(
      csvRow([
        csvRaw(t.id),
        csvRaw(istStamp(t.occurredAt)),
        csvText(t.memberName),
        csvRaw(t.type),
        csvRaw(direction),
        csvRaw(rupeesPlain(BigInt(t.amountPaise))),
        csvRaw(t.status),
        csvRaw(t.method ?? ""),
        csvRaw(t.paymentStatus ?? ""),
        csvText(t.reference),
        csvText(t.description),
        csvText(t.recordedBy),
        ...(admin ? [csvRaw(balance)] : []),
      ])
    );
  }

  await audit({
    actorId: viewer.userId,
    groupId,
    action: "TRANSACTIONS_EXPORTED",
    entityType: "Group",
    entityId: groupId,
    after: { rows: rows.length, scope: admin ? "ALL" : "OWN", filters: JSON.parse(JSON.stringify(q)) },
    ip: meta.ip,
    userAgent: meta.userAgent,
  });

  const today = new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10);
  // BOM so Excel reads names and ₹ correctly.
  return { csv: "\uFEFF" + lines.join("\r\n") + "\r\n", filename: `transactions-${today}.csv`, rows: rows.length };
}
