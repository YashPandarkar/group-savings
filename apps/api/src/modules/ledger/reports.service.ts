import type { Prisma } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { groupFundBalance } from "../../lib/ledger";
import { paiseToNumber } from "../../lib/money";
import { periodOf } from "../../lib/period";

type Tx = Prisma.TransactionClient;

// Savings per member, from the ledger (includes people who left but still have a balance).
export async function memberBalances(db: Tx, groupId: string) {
  const accounts = await db.ledgerAccount.findMany({
    where: { groupId, code: "MEMBER_SAVINGS", userId: { not: null } },
    include: { user: { select: { name: true } } },
  });
  const sums = await db.ledgerEntry.groupBy({
    by: ["accountId", "direction"],
    where: { groupId, accountId: { in: accounts.map((a) => a.id) } },
    _sum: { amountPaise: true },
  });
  const active = new Set(
    (await db.groupMember.findMany({ where: { groupId, status: "ACTIVE" }, select: { userId: true } })).map((m) => m.userId)
  );
  return accounts
    .map((a) => {
      let balance = 0n;
      for (const s of sums) {
        if (s.accountId !== a.id) continue;
        balance += (s.direction === "CREDIT" ? 1n : -1n) * (s._sum.amountPaise ?? 0n);
      }
      return { userId: a.userId as string, name: a.user?.name ?? "Unknown", active: active.has(a.userId as string), balance };
    })
    .sort((x, y) => x.name.localeCompare(y.name));
}

export async function fundReport(groupId: string) {
  const [fund, balances, byType] = await Promise.all([
    groupFundBalance(prisma, groupId),
    memberBalances(prisma, groupId),
    prisma.$queryRaw<{ type: string; count: number; total: bigint }[]>`
      SELECT lj.type::text AS type,
             COUNT(DISTINCT lj.id)::int AS count,
             COALESCE(SUM(e."amountPaise") FILTER (WHERE e.direction = 'DEBIT'), 0)::bigint AS total
      FROM ledger_journals lj
      JOIN ledger_entries e ON e."journalId" = lj.id
      WHERE lj."groupId" = ${groupId}
      GROUP BY lj.type
      ORDER BY lj.type
    `,
  ]);
  return {
    basis: "RECORDS",
    fundBalancePaise: paiseToNumber(fund),
    memberBalances: balances.map((b) => ({
      userId: b.userId, name: b.name, active: b.active, savingsPaise: paiseToNumber(b.balance),
    })),
    byType: byType.map((r) => ({ type: r.type, count: r.count, totalPaise: paiseToNumber(r.total) })),
  };
}

// Money in/out per calendar month (IST). Reversals show up in the month they were made.
export async function monthlySavings(groupId: string, year?: number) {
  const y = year ?? periodOf(new Date()).year;
  const rows = await prisma.$queryRaw<{ month: number; deposits: bigint; reversals: bigint; deposit_count: number }[]>`
    SELECT EXTRACT(MONTH FROM lj."occurredAt" + interval '330 minutes')::int AS month,
           COALESCE(SUM(e."amountPaise") FILTER (
             WHERE lj.type IN ('MONTHLY_DEPOSIT', 'ADDITIONAL_DEPOSIT') AND e.direction = 'DEBIT'), 0)::bigint AS deposits,
           COALESCE(SUM(e."amountPaise") FILTER (
             WHERE lj.type = 'REVERSAL' AND e.direction = 'CREDIT'), 0)::bigint AS reversals,
           (COUNT(*) FILTER (
             WHERE lj.type IN ('MONTHLY_DEPOSIT', 'ADDITIONAL_DEPOSIT') AND e.direction = 'DEBIT'))::int AS deposit_count
    FROM ledger_journals lj
    JOIN ledger_entries e ON e."journalId" = lj.id
    JOIN ledger_accounts a ON a.id = e."accountId" AND a.code = 'BANK_CLEARING'
    WHERE lj."groupId" = ${groupId}
      AND EXTRACT(YEAR FROM lj."occurredAt" + interval '330 minutes') = ${y}
    GROUP BY 1
  `;
  const byMonth = new Map(rows.map((r) => [r.month, r]));
  return {
    year: y,
    months: Array.from({ length: 12 }, (_, i) => {
      const r = byMonth.get(i + 1);
      const deposits = r?.deposits ?? 0n;
      const reversals = r?.reversals ?? 0n;
      return {
        month: i + 1,
        depositCount: r?.deposit_count ?? 0,
        depositsPaise: paiseToNumber(deposits),
        reversalsPaise: paiseToNumber(reversals),
        netPaise: paiseToNumber(deposits - reversals),
      };
    }),
  };
}

type Ids = { id: string }[];
const result = (name: string, bad: Ids, extra: Record<string, unknown> = {}) => ({
  name,
  ok: bad.length === 0,
  failures: bad.length,
  sampleIds: bad.slice(0, 10).map((b) => b.id),
  ...extra,
});

// Re-derives the books from scratch and reports anything that doesn't add up.
export async function integrityReport(groupId: string) {
  const unbalanced = await prisma.$queryRaw<Ids>`
    SELECT e."journalId" AS id
    FROM ledger_entries e
    WHERE e."groupId" = ${groupId}
    GROUP BY e."journalId"
    HAVING SUM(CASE WHEN e.direction = 'DEBIT' THEN e."amountPaise" ELSE -e."amountPaise" END) <> 0
    LIMIT 100`;

  // The gap noted in Phase 3: the database can't see a journal that has NO entries.
  const empty = await prisma.$queryRaw<Ids>`
    SELECT lj.id
    FROM ledger_journals lj
    LEFT JOIN ledger_entries e ON e."journalId" = lj.id
    WHERE lj."groupId" = ${groupId} AND e.id IS NULL
    LIMIT 100`;

  const net = await prisma.$queryRaw<{ net: bigint }[]>`
    SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN "amountPaise" ELSE -"amountPaise" END), 0)::bigint AS net
    FROM ledger_entries WHERE "groupId" = ${groupId}`;

  const fund = await groupFundBalance(prisma, groupId);
  const balances = await memberBalances(prisma, groupId);
  const negativeMembers = balances.filter((b) => b.balance < 0n).map((b) => ({ id: b.userId }));

  // Each contribution's "paid" figure must equal what the ledger says was received for it.
  const mismatched = await prisma.$queryRaw<Ids>`
    SELECT c.id
    FROM contributions c
    LEFT JOIN (
      SELECT pt."contributionId" AS cid,
             SUM(CASE WHEN lj.type = 'REVERSAL' THEN -amt.total ELSE amt.total END) AS net
      FROM ledger_journals lj
      JOIN payment_transactions pt ON pt.id = lj."paymentTransactionId"
      JOIN (
        SELECT "journalId", SUM("amountPaise") FILTER (WHERE direction = 'DEBIT') AS total
        FROM ledger_entries WHERE "groupId" = ${groupId}
        GROUP BY "journalId"
      ) amt ON amt."journalId" = lj.id
      WHERE pt."contributionId" IS NOT NULL AND lj."groupId" = ${groupId}
      GROUP BY pt."contributionId"
    ) x ON x.cid = c.id
    WHERE c."groupId" = ${groupId} AND c."paidPaise" <> COALESCE(x.net, 0)
    LIMIT 100`;

  const checks = [
    result("JOURNALS_BALANCED", unbalanced),
    result("NO_EMPTY_JOURNALS", empty),
    { name: "LEDGER_NETS_TO_ZERO", ok: net[0]?.net === 0n, failures: net[0]?.net === 0n ? 0 : 1, sampleIds: [] as string[] },
    { name: "FUND_NOT_NEGATIVE", ok: fund >= 0n, failures: fund >= 0n ? 0 : 1, sampleIds: [] as string[] },
    result("MEMBER_SAVINGS_NOT_NEGATIVE", negativeMembers),
    result("CONTRIBUTIONS_MATCH_LEDGER", mismatched),
  ];
  return {
    ok: checks.every((c) => c.ok),
    checkedAt: new Date(),
    basis: "RECORDS",
    fundBalancePaise: paiseToNumber(fund),
    checks,
  };
}
