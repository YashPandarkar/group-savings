import { describe, expect, it } from "vitest";
import request from "supertest";
import { prisma } from "../src/config/prisma";
import { app } from "./helpers";
import { addMember, addUsers, bearer, createGroup, makeUser, type TestUser } from "./groupHelpers";
import { getAccountId, groupFundBalance, postJournal } from "../src/lib/ledger";
import { memberSavingsBalance } from "../src/lib/ledgerAccounts";
import { periodOf } from "../src/lib/period";

let seq = 0;
const reqId = () => `tx-${Date.now()}-${++seq}`;

async function setup() {
  const president = await makeUser("President");
  const groupId = (await createGroup(president)).body.group.id as string;
  const vp = await makeUser("Vice President");
  await addMember(groupId, vp.id, "VICE_PRESIDENT");
  const [m1, m2] = await addUsers(groupId, 2); // named "Member 1", "Member 2"
  await prisma.groupMember.updateMany({ where: { groupId }, data: { joinedAt: new Date(Date.now() - 62 * 86_400_000) } });
  return { president, vp, m1, m2, groupId };
}

const deposit = (actor: TestUser, groupId: string, body: Record<string, unknown>) =>
  request(app)
    .post(`/api/groups/${groupId}/deposits/manual`)
    .set(bearer(actor.token))
    .send({
      purpose: "MONTHLY_DEPOSIT",
      amountPaise: 20000,
      method: "CASH",
      evidenceNote: "Cash received at the meeting",
      clientRequestId: reqId(),
      ...body,
    });

const list = (actor: TestUser, groupId: string, qs = "") =>
  request(app).get(`/api/groups/${groupId}/transactions${qs}`).set(bearer(actor.token));

const reverse = (actor: TestUser, groupId: string, id: string, reason = "Recorded against the wrong member") =>
  request(app).post(`/api/groups/${groupId}/transactions/${id}/reverse`).set(bearer(actor.token)).send({ reason });

async function threeDeposits() {
  const s = await setup();
  await deposit(s.president, s.groupId, { userId: s.m1.id });
  await deposit(s.president, s.groupId, { userId: s.m2.id });
  await deposit(s.vp, s.groupId, { userId: s.m1.id, purpose: "ADDITIONAL_DEPOSIT", amountPaise: 10000 });
  return s;
}

describe("transaction list", () => {
  it("admins see everything with a running balance; members see only their own", async () => {
    const { president, m1, groupId } = await threeDeposits();

    const admin = await list(president, groupId);
    expect(admin.status).toBe(200);
    expect(admin.body.total).toBe(3);
    expect(admin.body.items.map((i: { balanceAfterPaise: number }) => i.balanceAfterPaise)).toEqual([50000, 40000, 20000]);
    expect(admin.body.items[0].bankDeltaPaise).toBe(10000);

    const mine = await list(m1, groupId);
    expect(mine.body.total).toBe(2);
    expect(mine.body.items.every((i: { memberUserId: string }) => i.memberUserId === m1.id)).toBe(true);
    expect(mine.body.items[0].balanceAfterPaise).toBeUndefined();
    expect(mine.body.items[0].evidenceNote).toBeUndefined();
  });

  it("filters, searches, sorts and paginates", async () => {
    const { president, groupId } = await threeDeposits();
    const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

    expect((await list(president, groupId, "?type=ADDITIONAL_DEPOSIT")).body.total).toBe(1);
    expect((await list(president, groupId, "?q=Member%202")).body.total).toBe(1);
    expect((await list(president, groupId, "?q=member")).body.total).toBe(3);
    expect((await list(president, groupId, `?from=${today}&to=${today}`)).body.total).toBe(3);
    expect((await list(president, groupId, "?from=2099-01-01")).body.total).toBe(0);
    expect((await list(president, groupId, "?paymentStatus=SUCCESS")).body.total).toBe(3);
    expect((await list(president, groupId, "?paymentStatus=FAILED")).body.total).toBe(0);

    const first = (await list(president, groupId)).body.items[0];
    const byId = await list(president, groupId, `?q=${first.id.slice(0, 8)}`);
    expect(byId.body.total).toBe(1);
    expect(byId.body.items[0].id).toBe(first.id);

    const p1 = await list(president, groupId, "?pageSize=2");
    const p2 = await list(president, groupId, "?pageSize=2&page=2");
    expect(p1.body.items).toHaveLength(2);
    expect(p2.body.items).toHaveLength(1);
    expect((await list(president, groupId, "?sort=date_asc")).body.items[0].balanceAfterPaise).toBe(20000);

    expect((await list(president, groupId, "?from=2026-12-01&to=2026-01-01")).status).toBe(400);
    expect((await list(president, groupId, "?type=NOPE")).status).toBe(400);
    expect((await list(president, groupId, "?pageSize=1000")).status).toBe(400);
  });

  it("GROUP ISOLATION: another group's President gets 404 everywhere", async () => {
    const { president, groupId } = await threeDeposits();
    const outsider = await makeUser();
    await createGroup(outsider, { name: "Other Circle" });
    const id = (await list(president, groupId)).body.items[0].id;

    expect((await list(outsider, groupId)).status).toBe(404);
    expect((await request(app).get(`/api/groups/${groupId}/transactions/${id}`).set(bearer(outsider.token))).status).toBe(404);
    expect((await request(app).get(`/api/groups/${groupId}/transactions/export.csv`).set(bearer(outsider.token))).status).toBe(404);
    expect((await request(app).get(`/api/groups/${groupId}/transactions/summary`).set(bearer(outsider.token))).status).toBe(404);
    expect((await reverse(outsider, groupId, id)).status).toBe(404);
  });
});

describe("transaction detail and summary", () => {
  it("members open their own transaction but not someone else's", async () => {
    const { president, m1, m2, groupId } = await setup();
    const a = await deposit(president, groupId, { userId: m1.id });
    await deposit(president, groupId, { userId: m2.id });
    const all = (await list(president, groupId)).body.items as { id: string; memberUserId: string }[];
    const mine = all.find((i) => i.memberUserId === m1.id)!;
    const theirs = all.find((i) => i.memberUserId === m2.id)!;
    expect(a.status).toBe(201);

    const own = await request(app).get(`/api/groups/${groupId}/transactions/${mine.id}`).set(bearer(m1.token));
    expect(own.status).toBe(200);
    expect(own.body.lines).toHaveLength(2);
    expect((await request(app).get(`/api/groups/${groupId}/transactions/${theirs.id}`).set(bearer(m1.token))).status).toBe(404);
    expect((await request(app).get(`/api/groups/${groupId}/transactions/${theirs.id}`).set(bearer(president.token))).status).toBe(200);
  });

  it("summary shows the fund balance and my own savings", async () => {
    const { m1, groupId } = await threeDeposits();
    const res = await request(app).get(`/api/groups/${groupId}/transactions/summary`).set(bearer(m1.token));
    expect(res.status).toBe(200);
    expect(res.body.basis).toBe("RECORDS");
    expect(res.body.fundBalancePaise).toBe(50000);
    expect(res.body.mySavingsPaise).toBe(30000);
  });
});

describe("CSV export", () => {
  it("neutralises formulas, scopes members to their own rows, and is audited", async () => {
    const president = await makeUser("President");
    const groupId = (await createGroup(president)).body.group.id as string;
    const evil = await makeUser("=SUM(1+1)");
    const other = await makeUser("Other Person");
    await addMember(groupId, evil.id);
    await addMember(groupId, other.id);
    await prisma.groupMember.updateMany({ where: { groupId }, data: { joinedAt: new Date(Date.now() - 62 * 86_400_000) } });
    await deposit(president, groupId, { userId: evil.id });
    await deposit(president, groupId, { userId: other.id });

    const res = await request(app).get(`/api/groups/${groupId}/transactions/export.csv`).set(bearer(president.token));
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.headers["content-disposition"]).toMatch(/attachment; filename="transactions-\d{4}-\d{2}-\d{2}\.csv"/);
    expect(res.text.startsWith("\uFEFF")).toBe(true);
    expect(res.text).toContain("'=SUM(1+1)");
    expect(res.text).not.toMatch(/,=SUM/);
    expect(res.text.trim().split("\r\n")).toHaveLength(3); // header + 2 rows

    const mine = await request(app).get(`/api/groups/${groupId}/transactions/export.csv`).set(bearer(evil.token));
    expect(mine.text.trim().split("\r\n")).toHaveLength(2); // header + only their row
    expect(mine.text).not.toContain("Other Person");

    expect(await prisma.auditLog.count({ where: { groupId, action: "TRANSACTIONS_EXPORTED" } })).toBe(2);
  });
});

describe("reversals", () => {
  async function oneDeposit() {
    const s = await setup();
    await deposit(s.president, s.groupId, { userId: s.m1.id });
    const journalId = (await list(s.president, s.groupId)).body.items[0].id as string;
    return { ...s, journalId };
  }

  it("reverses a deposit: new mirror journal, contribution rolled back, nothing edited", async () => {
    const { president, m1, groupId, journalId } = await oneDeposit();
    expect(await groupFundBalance(prisma, groupId)).toBe(20000n);

    const res = await reverse(president, groupId, journalId);
    expect(res.status).toBe(201);

    expect(await groupFundBalance(prisma, groupId)).toBe(0n);
    expect(await memberSavingsBalance(prisma, groupId, m1.id)).toBe(0n);
    const c = await prisma.contribution.findFirstOrThrow({ where: { groupId, userId: m1.id } });
    expect(c.status).toBe("PENDING");
    expect(c.paidPaise).toBe(0n);

    expect(await prisma.ledgerJournal.count({ where: { groupId } })).toBe(2); // original kept
    const rev = await prisma.ledgerJournal.findUniqueOrThrow({ where: { id: res.body.reversalId }, include: { entries: true } });
    expect(rev.type).toBe("REVERSAL");
    expect(rev.reversalOfId).toBe(journalId);
    expect(rev.entries).toHaveLength(2);

    expect((await list(president, groupId, "?status=REVERSED")).body.total).toBe(1);
    expect((await list(president, groupId, "?status=REVERSAL")).body.total).toBe(1);
    expect((await list(president, groupId, "?status=POSTED")).body.total).toBe(0);
    expect(await prisma.notification.count({ where: { userId: m1.id, type: "DEPOSIT_REVERSED" } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { groupId, action: "TRANSACTION_REVERSED" } })).toBe(1);
  });

  it("only the President can reverse; a reason is required", async () => {
    const { vp, m1, president, groupId, journalId } = await oneDeposit();
    expect((await reverse(m1, groupId, journalId)).status).toBe(403);
    expect((await reverse(vp, groupId, journalId)).status).toBe(403);
    expect((await reverse(president, groupId, journalId, "short")).status).toBe(400);
    expect(await prisma.ledgerJournal.count({ where: { groupId } })).toBe(1);
  });

  it("a transaction can be reversed once, and a reversal can't be reversed", async () => {
    const { president, groupId, journalId } = await oneDeposit();
    const first = await reverse(president, groupId, journalId);
    const again = await reverse(president, groupId, journalId);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("ALREADY_REVERSED");

    const meta = await reverse(president, groupId, first.body.reversalId);
    expect(meta.status).toBe(409);
    expect(meta.body.error.code).toBe("CANNOT_REVERSE_REVERSAL");
  });

  it("two simultaneous reversals: exactly one wins", async () => {
    const { president, groupId, journalId } = await oneDeposit();
    const [a, b] = await Promise.all([reverse(president, groupId, journalId), reverse(president, groupId, journalId)]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(await prisma.ledgerJournal.count({ where: { groupId, type: "REVERSAL" } })).toBe(1);
    expect(await groupFundBalance(prisma, groupId)).toBe(0n);
  });

  it("is refused when the money has already left, and non-deposit journals are not reversible here", async () => {
    const { president, m1, groupId, journalId } = await oneDeposit();
    const bank = await getAccountId(prisma, groupId, "BANK_CLEARING");
    const savings = await getAccountId(prisma, groupId, "MEMBER_SAVINGS", m1.id);
    await prisma.$transaction((tx) =>
      postJournal(tx, {
        groupId, type: "GROUP_WITHDRAWAL", description: "payout", createdById: president.id,
        lines: [
          { accountId: savings, direction: "DEBIT", amountPaise: 20000n },
          { accountId: bank, direction: "CREDIT", amountPaise: 20000n },
        ],
      })
    );

    const blocked = await reverse(president, groupId, journalId);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("INSUFFICIENT_FUND");

    const payoutId = (await list(president, groupId, "?type=GROUP_WITHDRAWAL")).body.items[0].id;
    const notDeposit = await reverse(president, groupId, payoutId);
    expect(notDeposit.status).toBe(409);
    expect(notDeposit.body.error.code).toBe("NOT_REVERSIBLE");
  });
});

describe("reports and integrity", () => {
  it("fund report: balance, per-member savings and totals by type", async () => {
    const { president, vp, m1, groupId } = await threeDeposits();
    const res = await request(app).get(`/api/groups/${groupId}/reports/fund`).set(bearer(president.token));
    expect(res.status).toBe(200);
    expect(res.body.fundBalancePaise).toBe(50000);
    const byName = Object.fromEntries(res.body.memberBalances.map((b: { name: string; savingsPaise: number }) => [b.name, b.savingsPaise]));
    expect(byName["Member 1"]).toBe(30000);
    expect(byName["Member 2"]).toBe(20000);
    const monthly = res.body.byType.find((t: { type: string }) => t.type === "MONTHLY_DEPOSIT");
    expect(monthly).toMatchObject({ count: 2, totalPaise: 40000 });

    expect((await request(app).get(`/api/groups/${groupId}/reports/fund`).set(bearer(vp.token))).status).toBe(200);
    expect((await request(app).get(`/api/groups/${groupId}/reports/fund`).set(bearer(m1.token))).status).toBe(403);
  });

  it("monthly report puts deposits and reversals in the right month", async () => {
    const { president, groupId } = await threeDeposits();
    const { year, month } = periodOf(new Date());
    const before = await request(app).get(`/api/groups/${groupId}/reports/monthly?year=${year}`).set(bearer(president.token));
    expect(before.body.months).toHaveLength(12);
    expect(before.body.months[month - 1]).toMatchObject({ depositCount: 3, depositsPaise: 50000, reversalsPaise: 0 });

    const id = (await list(president, groupId, "?type=ADDITIONAL_DEPOSIT")).body.items[0].id;
    await reverse(president, groupId, id);
    const after = await request(app).get(`/api/groups/${groupId}/reports/monthly`).set(bearer(president.token));
    expect(after.body.months[month - 1]).toMatchObject({ depositsPaise: 50000, reversalsPaise: 10000, netPaise: 40000 });
  });

  it("integrity check passes on healthy books and catches tampering", async () => {
    const { president, groupId } = await threeDeposits();
    const check = () => request(app).get(`/api/groups/${groupId}/reports/integrity`).set(bearer(president.token));

    const healthy = await check();
    expect(healthy.status).toBe(200);
    expect(healthy.body.ok).toBe(true);
    expect(healthy.body.checks).toHaveLength(6);

    // Someone edits a contribution by hand, bypassing the ledger.
    await prisma.contribution.updateMany({ where: { groupId, paidPaise: { gt: 0n } }, data: { paidPaise: 99999n } });
    const tampered = await check();
    expect(tampered.body.ok).toBe(false);
    expect(tampered.body.checks.find((c: { name: string }) => c.name === "CONTRIBUTIONS_MATCH_LEDGER").ok).toBe(false);
  });

  it("integrity check finds a journal that has no entries", async () => {
    const { president, groupId } = await setup();
    await prisma.ledgerJournal.create({
      data: { groupId, type: "ADJUSTMENT", description: "empty", createdById: president.id },
    });
    const res = await request(app).get(`/api/groups/${groupId}/reports/integrity`).set(bearer(president.token));
    expect(res.body.ok).toBe(false);
    expect(res.body.checks.find((c: { name: string }) => c.name === "NO_EMPTY_JOURNALS").failures).toBe(1);
  });
});
