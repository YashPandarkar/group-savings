import { describe, expect, it } from "vitest";
import request from "supertest";
import { prisma } from "../src/config/prisma";
import { app } from "./helpers";
import { addMember, addUsers, bearer, createGroup, makeUser, memberIdOf, type TestUser } from "./groupHelpers";
import { dueDateFor, periodOf } from "../src/lib/period";
import { ensureContributions } from "../src/modules/contributions/contributions.service";
import { groupFundBalance } from "../src/lib/ledger";
import { memberSavingsBalance } from "../src/lib/ledgerAccounts";

let seq = 0;
const reqId = () => `req-${Date.now()}-${++seq}`;
const utr = () => `UTR${Date.now()}${++seq}`;

// President + Vice President + 2 members, all "joined two months ago" so the
// joined-before-the-due-date rule includes them whatever today's date is.
async function setup() {
  const president = await makeUser("President");
  const groupId = (await createGroup(president)).body.group.id as string;
  const vp = await makeUser("Vice President");
  await addMember(groupId, vp.id, "VICE_PRESIDENT");
  const [m1, m2] = await addUsers(groupId, 2);
  await prisma.groupMember.updateMany({ where: { groupId }, data: { joinedAt: new Date(Date.now() - 62 * 86_400_000) } });
  return { president, vp, m1, m2, groupId };
}

const record = (actor: TestUser, groupId: string, body: Record<string, unknown>) =>
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

describe("contribution generator", () => {
  it("is idempotent and skips members who joined after the due date", async () => {
    const { m2, groupId } = await setup();
    const { year, month } = periodOf(new Date());
    const due = dueDateFor(year, month, 10);
    await prisma.groupMember.updateMany({ where: { groupId, userId: m2.id }, data: { joinedAt: new Date(due.getTime() + 3_600_000) } });

    const first = await ensureContributions(prisma, groupId, year, month);
    const second = await ensureContributions(prisma, groupId, year, month);
    expect(first).toBe(3); // President, VP, m1 (not the late joiner)
    expect(second).toBe(0);
    expect(await prisma.contribution.count({ where: { groupId, userId: m2.id } })).toBe(0);
  });
});

describe("recording a manual deposit", () => {
  it("updates the contribution, posts a balanced journal, notifies and audits", async () => {
    const { president, m1, groupId } = await setup();
    const res = await record(president, groupId, { userId: m1.id });
    expect(res.status).toBe(201);
    expect(res.body.deposit.source).toBe("MANUAL");
    expect(res.body.deposit.amountPaise).toBe(20000);

    const c = await prisma.contribution.findFirstOrThrow({ where: { groupId, userId: m1.id } });
    expect(c.status).toBe("PAID");
    expect(c.paidPaise).toBe(20000n);

    const journal = await prisma.ledgerJournal.findFirstOrThrow({ where: { groupId }, include: { entries: true } });
    expect(journal.entries).toHaveLength(2);
    expect(journal.paymentTransactionId).toBe(res.body.deposit.id);

    expect(await groupFundBalance(prisma, groupId)).toBe(20000n);
    expect(await memberSavingsBalance(prisma, groupId, m1.id)).toBe(20000n);
    expect(await prisma.notification.count({ where: { userId: m1.id, type: "DEPOSIT_RECORDED" } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { groupId, action: "DEPOSIT_RECORDED_MANUAL" } })).toBe(1);
  });

  it("members can't record deposits (403); the VP can; nobody can record their own", async () => {
    const { president, vp, m1, m2, groupId } = await setup();
    expect((await record(m1, groupId, { userId: m2.id })).status).toBe(403);
    expect((await record(vp, groupId, { userId: m1.id })).status).toBe(201);

    const own = await record(president, groupId, { userId: president.id });
    expect(own.status).toBe(403);
    expect(own.body.error.code).toBe("CANNOT_RECORD_OWN_DEPOSIT");
  });

  it("GROUP ISOLATION: can't record for a stranger or from another group", async () => {
    const { president, groupId } = await setup();
    const other = await setup();
    // A user who belongs to a DIFFERENT group is not a member of this one.
    expect((await record(president, groupId, { userId: other.m1.id })).status).toBe(404);
    // Another group's President can't reach this group at all.
    expect((await record(other.president, groupId, { userId: other.m1.id })).status).toBe(404);
  });

  it("a retry with the same clientRequestId is not credited twice", async () => {
    const { president, m1, groupId } = await setup();
    const body = { userId: m1.id, clientRequestId: reqId() };
    const a = await record(president, groupId, body);
    const b = await record(president, groupId, body);
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.replayed).toBe(true);
    expect(b.body.deposit.id).toBe(a.body.deposit.id);
    expect(await prisma.paymentTransaction.count({ where: { groupId } })).toBe(1);
    expect(await prisma.ledgerJournal.count({ where: { groupId } })).toBe(1);
  });

  it("two simultaneous identical requests: one credit, one replay", async () => {
    const { president, m1, groupId } = await setup();
    const body = { userId: m1.id, clientRequestId: reqId() };
    const [a, b] = await Promise.all([record(president, groupId, body), record(president, groupId, body)]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(await prisma.ledgerJournal.count({ where: { groupId } })).toBe(1);
  });

  it("two admins paying the same contribution at once: only one succeeds (row lock)", async () => {
    const { president, vp, m1, groupId } = await setup();
    const [a, b] = await Promise.all([
      record(president, groupId, { userId: m1.id }),
      record(vp, groupId, { userId: m1.id }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(await groupFundBalance(prisma, groupId)).toBe(20000n);
  });

  it("the same bank reference can't be recorded twice", async () => {
    const { president, m1, m2, groupId } = await setup();
    const ref = utr();
    expect((await record(president, groupId, { userId: m1.id, method: "UPI", paymentReference: ref })).status).toBe(201);
    const dup = await record(president, groupId, { userId: m2.id, method: "UPI", paymentReference: ref.toLowerCase() });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("DUPLICATE_PAYMENT_REFERENCE");
    expect(await groupFundBalance(prisma, groupId)).toBe(20000n); // the failed attempt left nothing behind
  });

  it("supports partial payments, then refuses to overpay the month", async () => {
    const { president, m1, groupId } = await setup();
    await record(president, groupId, { userId: m1.id, amountPaise: 5000 });
    let c = await prisma.contribution.findFirstOrThrow({ where: { groupId, userId: m1.id } });
    expect(c.status).toBe("PARTIAL");

    const tooMuch = await record(president, groupId, { userId: m1.id, amountPaise: 20000 });
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.body.error.code).toBe("AMOUNT_EXCEEDS_DUE");

    expect((await record(president, groupId, { userId: m1.id, amountPaise: 15000 })).status).toBe(201);
    c = await prisma.contribution.findFirstOrThrow({ where: { groupId, userId: m1.id } });
    expect(c.status).toBe("PAID");

    const again = await record(president, groupId, { userId: m1.id, amountPaise: 100 });
    expect(again.status).toBe(409); // nothing left to pay this month
  });

  it("additional deposits add savings without touching contributions", async () => {
    const { president, m1, groupId } = await setup();
    const res = await record(president, groupId, { userId: m1.id, purpose: "ADDITIONAL_DEPOSIT", amountPaise: 150000 });
    expect(res.status).toBe(201);
    expect(res.body.deposit.contributionId).toBeNull();
    expect(await prisma.contribution.count({ where: { groupId, status: { in: ["PAID", "PARTIAL"] } } })).toBe(0);
    expect(await memberSavingsBalance(prisma, groupId, m1.id)).toBe(150000n);
    const j = await prisma.ledgerJournal.findFirstOrThrow({ where: { groupId } });
    expect(j.type).toBe("ADDITIONAL_DEPOSIT");
  });

  it("applies to the OLDEST unpaid month and tracks lateness", async () => {
    const { president, m1, groupId } = await setup();
    const cur = periodOf(new Date());
    const prev = cur.month === 1 ? { year: cur.year - 1, month: 12 } : { year: cur.year, month: cur.month - 1 };
    await prisma.contribution.create({
      data: {
        groupId, userId: m1.id, periodYear: prev.year, periodMonth: prev.month,
        dueDate: dueDateFor(prev.year, prev.month, 10), expectedPaise: 20000n,
      },
    });
    const m1MembershipId = await memberIdOf(groupId, m1.id);
    const history = () => request(app).get(`/api/groups/${groupId}/contributions/${m1MembershipId}`).set(bearer(president.token));
    const rowFor = (items: { periodYear: number; periodMonth: number }[], p: { year: number; month: number }) =>
      items.find((i) => i.periodYear === p.year && i.periodMonth === p.month) as Record<string, unknown>;

    let rows = (await history()).body.items;
    expect(rowFor(rows, prev).overdue).toBe(true);

    expect((await record(president, groupId, { userId: m1.id })).status).toBe(201); // no period given

    rows = (await history()).body.items;
    expect(rowFor(rows, prev).status).toBe("PAID");
    expect(rowFor(rows, prev).paidLate).toBe(true);
    expect(rowFor(rows, prev).overdue).toBe(false);
    expect(rowFor(rows, cur).status).toBe("PENDING"); // the current month is untouched
  });

  it("validates input", async () => {
    const { president, m1, groupId } = await setup();
    const bad = async (body: Record<string, unknown>) => (await record(president, groupId, { userId: m1.id, ...body })).status;

    expect(await bad({ method: "UPI" })).toBe(400); // non-cash needs a reference
    expect(await bad({ amountPaise: 50 })).toBe(400); // below ₹1
    expect(await bad({ amountPaise: 200.5 })).toBe(400); // not whole paise
    expect(await bad({ evidenceNote: "ok" })).toBe(400); // evidence too short
    expect(await bad({ paidAt: new Date(Date.now() + 86_400_000).toISOString() })).toBe(400); // future
    expect(await bad({ periodYear: 2026 })).toBe(400); // year without month
    expect(await bad({ purpose: "ADDITIONAL_DEPOSIT", periodYear: 2026, periodMonth: 1 })).toBe(400);
    expect(await bad({ clientRequestId: "short" })).toBe(400);
    expect(await prisma.ledgerJournal.count({ where: { groupId } })).toBe(0);
  });
});

describe("reading contributions and deposits", () => {
  it("the dashboard totals add up and is limited to President and VP", async () => {
    const { president, vp, m1, groupId } = await setup();
    await record(president, groupId, { userId: m1.id });

    const res = await request(app).get(`/api/groups/${groupId}/contributions`).set(bearer(president.token));
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(4);
    expect(res.body.summary.expectedPaise).toBe(80000);
    expect(res.body.summary.collectedPaise).toBe(20000);
    expect(res.body.summary.pendingPaise).toBe(60000);
    expect(res.body.summary.counts.paid).toBe(1);
    expect(res.body.summary.counts.pending).toBe(3);

    expect((await request(app).get(`/api/groups/${groupId}/contributions`).set(bearer(vp.token))).status).toBe(200);
    expect((await request(app).get(`/api/groups/${groupId}/contributions`).set(bearer(m1.token))).status).toBe(403);
    expect((await request(app).get(`/api/groups/${groupId}/contributions?year=2026`).set(bearer(president.token))).status).toBe(400);
  });

  it("members see only their own history", async () => {
    const { president, m1, groupId } = await setup();
    const mine = await request(app).get(`/api/groups/${groupId}/contributions/me`).set(bearer(m1.token));
    expect(mine.status).toBe(200);
    expect(mine.body.items.length).toBeGreaterThan(0);
    expect(mine.body.items.every((i: { userId: string }) => i.userId === m1.id)).toBe(true);

    const presidentMembershipId = await memberIdOf(groupId, president.id);
    const other = await request(app).get(`/api/groups/${groupId}/contributions/${presidentMembershipId}`).set(bearer(m1.token));
    expect(other.status).toBe(403);
  });

  it("another group's President gets 404", async () => {
    const { groupId } = await setup();
    const outsider = await makeUser();
    await createGroup(outsider, { name: "Other Circle" });
    expect((await request(app).get(`/api/groups/${groupId}/contributions`).set(bearer(outsider.token))).status).toBe(404);
    expect((await request(app).get(`/api/groups/${groupId}/deposits`).set(bearer(outsider.token))).status).toBe(404);
  });

  it("deposit history: members see their own (without evidence), admins see all", async () => {
    const { president, m1, m2, groupId } = await setup();
    await record(president, groupId, { userId: m1.id });
    await record(president, groupId, { userId: m2.id });
    await record(president, groupId, { userId: m1.id, purpose: "ADDITIONAL_DEPOSIT", amountPaise: 10000 });

    const mine = await request(app).get(`/api/groups/${groupId}/deposits`).set(bearer(m1.token));
    expect(mine.body.total).toBe(2);
    expect(mine.body.items.every((d: { userId: string }) => d.userId === m1.id)).toBe(true);
    expect(mine.body.items[0].evidenceNote).toBeUndefined();

    const all = await request(app).get(`/api/groups/${groupId}/deposits?pageSize=2`).set(bearer(president.token));
    expect(all.body.total).toBe(3);
    expect(all.body.items).toHaveLength(2);
    expect(all.body.items[0].evidenceNote).toBeTypeOf("string");
  });
});
