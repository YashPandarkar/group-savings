import { describe, expect, it } from "vitest";
import request from "supertest";
import { prisma } from "../src/config/prisma";
import { app } from "./helpers";
import { addMember, addUsers, bearer, createGroup, makeUser, type TestUser } from "./groupHelpers";
import { groupFundBalance } from "../src/lib/ledger";
import { memberSavingsBalance } from "../src/lib/ledgerAccounts";

let seq = 0;
const nid = () => `wd-${Date.now()}-${++seq}`;
const utr = () => `WD${Date.now()}${++seq}`;

const deposit = (actor: TestUser, groupId: string, userId: string, amountPaise: number) =>
  request(app)
    .post(`/api/groups/${groupId}/deposits/manual`)
    .set(bearer(actor.token))
    .send({
      userId, purpose: "ADDITIONAL_DEPOSIT", amountPaise, method: "CASH",
      evidenceNote: "Cash received at the meeting", clientRequestId: nid(),
    });

// President, VP, two members. Savings: Member 1 has ₹5,000, Member 2 has ₹1,000 (fund ₹6,000).
async function setup() {
  const president = await makeUser("President");
  const groupId = (await createGroup(president)).body.group.id as string;
  const vp = await makeUser("Vice President");
  await addMember(groupId, vp.id, "VICE_PRESIDENT");
  const [m1, m2] = await addUsers(groupId, 2);
  expect((await deposit(president, groupId, m1.id, 500000)).status).toBe(201);
  expect((await deposit(president, groupId, m2.id, 100000)).status).toBe(201);
  return { president, vp, m1, m2, groupId };
}
type S = Awaited<ReturnType<typeof setup>>;

const payout = (u: TestUser, groupId: string, beneficiary: TestUser, amountPaise: number, extra: Record<string, unknown> = {}) =>
  request(app).post(`/api/groups/${groupId}/withdrawals`).set(bearer(u.token)).send({
    kind: "MEMBER_PAYOUT", beneficiaryUserId: beneficiary.id, amountPaise, purpose: "Payout of savings", ...extra,
  });
const expense = (u: TestUser, groupId: string, amountPaise: number) =>
  request(app).post(`/api/groups/${groupId}/withdrawals`).set(bearer(u.token)).send({
    kind: "GROUP_EXPENSE", amountPaise, purpose: "Bank charges for the year",
  });
const act = (u: TestUser, id: string, action: string, body: Record<string, unknown> = {}) =>
  request(app).post(`/api/withdrawals/${id}/${action}`).set(bearer(u.token)).send(body);
const getW = (u: TestUser, id: string) => request(app).get(`/api/withdrawals/${id}`).set(bearer(u.token));
const cash = (extra: Record<string, unknown> = {}) => ({ method: "CASH", note: "Cash handed over at the meeting", ...extra });
const bank = () => ({ method: "BANK_TRANSFER", reference: utr(), note: "Transferred from the group account" });
const integrity = (s: S) => request(app).get(`/api/groups/${s.groupId}/reports/integrity`).set(bearer(s.president.token));
const setDual = (s: S, on: boolean) =>
  request(app).put(`/api/groups/${s.groupId}`).set(bearer(s.president.token)).send({ requireDualApproval: on }).expect(200);

describe("requesting and completing a payout", () => {
  it("is approved by the request but moves no money until the transfer is recorded", async () => {
    const s = await setup();
    const r = await payout(s.president, s.groupId, s.m1, 200000);
    expect(r.status).toBe(201);
    expect(r.body.withdrawal).toMatchObject({ kind: "MEMBER_PAYOUT", status: "APPROVED", amountPaise: 200000 });
    expect(r.body.withdrawal.statusNote).toContain("NOTHING HAS BEEN SENT");
    const id = r.body.withdrawal.id as string;

    expect(await groupFundBalance(prisma, s.groupId)).toBe(600000n); // nothing has moved
    expect(await prisma.ledgerJournal.count({ where: { groupId: s.groupId, type: "GROUP_WITHDRAWAL" } })).toBe(0);

    const done = await act(s.vp, id, "complete", bank());
    expect(done.status).toBe(200);
    expect(done.body.withdrawal).toMatchObject({ status: "COMPLETED", completedBy: "Vice President" });
    expect(done.body.withdrawal.statusNote).toContain("Check your bank account");

    expect(await groupFundBalance(prisma, s.groupId)).toBe(400000n);
    expect(await memberSavingsBalance(prisma, s.groupId, s.m1.id)).toBe(300000n);
    const journal = await prisma.ledgerJournal.findFirstOrThrow({ where: { groupId: s.groupId, type: "GROUP_WITHDRAWAL" }, include: { entries: true } });
    expect(journal.withdrawalId).toBe(id);
    expect(journal.entries).toHaveLength(2);
    expect(await prisma.notification.count({ where: { userId: s.m1.id, type: "WITHDRAWAL_COMPLETED" } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { groupId: s.groupId, action: "WITHDRAWAL_COMPLETED" } })).toBe(1);

    const txs = await request(app).get(`/api/groups/${s.groupId}/transactions?type=GROUP_WITHDRAWAL`).set(bearer(s.president.token));
    expect(txs.body.items[0]).toMatchObject({ bankDeltaPaise: -200000, memberName: "Member 1" });
    expect((await integrity(s)).body.ok).toBe(true);
  });

  it("a double-click on 'request' returns the same withdrawal", async () => {
    const s = await setup();
    const a = await payout(s.president, s.groupId, s.m1, 100000);
    const b = await payout(s.president, s.groupId, s.m1, 100000);
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.replayed).toBe(true);
    expect(b.body.withdrawal.id).toBe(a.body.withdrawal.id);
    expect(await prisma.withdrawal.count({ where: { groupId: s.groupId } })).toBe(1);
  });

  it("completing twice posts one journal, even in parallel; a different reference is refused", async () => {
    const s = await setup();
    const id = (await payout(s.president, s.groupId, s.m1, 100000)).body.withdrawal.id as string;
    const body = cash();
    const [a, b] = await Promise.all([act(s.vp, id, "complete", body), act(s.president, id, "complete", body)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect([a.body.replayed, b.body.replayed].sort()).toEqual([false, true]);
    expect(await prisma.ledgerJournal.count({ where: { groupId: s.groupId, type: "GROUP_WITHDRAWAL" } })).toBe(1);
    expect(await groupFundBalance(prisma, s.groupId)).toBe(500000n);

    const other = await act(s.vp, id, "complete", bank());
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe("ALREADY_COMPLETED");
  });

  it("completion needs a reference for non-cash transfers, and a reference can't be reused", async () => {
    const s = await setup();
    const a = (await payout(s.president, s.groupId, s.m1, 100000)).body.withdrawal.id as string;
    const b = (await payout(s.president, s.groupId, s.m2, 50000)).body.withdrawal.id as string;

    expect((await act(s.vp, a, "complete", { method: "UPI", note: "Sent via UPI" })).status).toBe(400);
    const ref = utr();
    expect((await act(s.vp, a, "complete", { method: "UPI", reference: ref, note: "Sent via UPI" })).status).toBe(200);
    const dup = await act(s.vp, b, "complete", { method: "UPI", reference: ref.toLowerCase(), note: "Sent via UPI" });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("DUPLICATE_PAYMENT_REFERENCE");
    expect((await getW(s.president, b)).body.withdrawal.status).toBe("APPROVED"); // the refusal left it untouched
  });
});

describe("who may do what", () => {
  it("members can't request; the VP can; members see only payouts made to them", async () => {
    const s = await setup();
    expect((await payout(s.m1, s.groupId, s.m1, 100000)).status).toBe(403);

    const toM1 = await payout(s.vp, s.groupId, s.m1, 100000);
    const toM2 = await payout(s.president, s.groupId, s.m2, 50000);
    expect(toM1.status).toBe(201);
    expect(toM2.status).toBe(201);

    const mine = await request(app).get(`/api/groups/${s.groupId}/withdrawals`).set(bearer(s.m1.token));
    expect(mine.status).toBe(200);
    expect(mine.body.total).toBe(1);
    expect(mine.body.items[0].beneficiary.userId).toBe(s.m1.id);
    expect(mine.body.items[0].requestedBy).toBeUndefined(); // administrator details are hidden

    const all = await request(app).get(`/api/groups/${s.groupId}/withdrawals`).set(bearer(s.president.token));
    expect(all.body.total).toBe(2);
    expect(all.body.items[0].requestedBy).toBeDefined();

    expect((await getW(s.m1, toM1.body.withdrawal.id)).status).toBe(200);
    expect((await getW(s.m1, toM2.body.withdrawal.id)).status).toBe(404);
    expect((await act(s.m1, toM1.body.withdrawal.id, "approve")).status).toBe(403);
    expect((await act(s.m1, toM1.body.withdrawal.id, "complete", cash())).status).toBe(403);
  });

  it("GROUP ISOLATION: another group's President gets 404 everywhere", async () => {
    const s = await setup();
    const other = await setup();
    const id = (await payout(s.president, s.groupId, s.m1, 100000)).body.withdrawal.id as string;

    expect((await getW(other.president, id)).status).toBe(404);
    expect((await act(other.president, id, "approve")).status).toBe(404);
    expect((await act(other.president, id, "reject", { reason: "Trying to interfere" })).status).toBe(404);
    expect((await act(other.president, id, "complete", cash())).status).toBe(404);
    expect((await request(app).get(`/api/groups/${s.groupId}/withdrawals`).set(bearer(other.president.token))).status).toBe(404);
    expect((await payout(other.president, s.groupId, s.m1, 100000, { amountPaise: 90000 })).status).toBe(404);
    expect((await request(app).get(`/api/withdrawals/${id}`)).status).toBe(401);
    expect((await getW(s.president, "does-not-exist")).status).toBe(404);
    expect((await prisma.withdrawal.findUniqueOrThrow({ where: { id } })).status).toBe("APPROVED");
  });

  it("validates input", async () => {
    const s = await setup();
    const other = await setup();
    const post = (body: Record<string, unknown>) =>
      request(app).post(`/api/groups/${s.groupId}/withdrawals`).set(bearer(s.president.token)).send(body);
    const base = { kind: "MEMBER_PAYOUT", beneficiaryUserId: s.m1.id, amountPaise: 100000, purpose: "Payout of savings" };

    expect((await post({ ...base, beneficiaryUserId: undefined })).status).toBe(400);
    expect((await post({ ...base, kind: "GROUP_EXPENSE" })).status).toBe(400); // an expense has no beneficiary
    expect((await post({ ...base, amountPaise: 50 })).status).toBe(400);
    expect((await post({ ...base, amountPaise: 10000.5 })).status).toBe(400);
    expect((await post({ ...base, purpose: "x" })).status).toBe(400);
    expect((await post({ ...base, kind: "SOMETHING" })).status).toBe(400);
    expect((await post({ ...base, beneficiaryUserId: other.m1.id })).status).toBe(404); // not in this group
    expect(await prisma.withdrawal.count({ where: { groupId: s.groupId } })).toBe(0);
  });
});

describe("approval rules", () => {
  it("with dual approval, the request waits for the OTHER administrator", async () => {
    const s = await setup();
    await setDual(s, true);
    const r = await payout(s.president, s.groupId, s.m1, 100000);
    expect(r.body.withdrawal.status).toBe("PENDING");
    const id = r.body.withdrawal.id as string;
    expect(await prisma.notification.count({ where: { userId: s.vp.id, type: "WITHDRAWAL_APPROVAL_NEEDED" } })).toBe(1);

    expect((await act(s.vp, id, "complete", cash())).body.error.code).toBe("INVALID_STATE"); // not approved yet
    const own = await act(s.president, id, "approve");
    expect(own.status).toBe(403);
    expect(own.body.error.code).toBe("CANNOT_APPROVE_OWN_REQUEST");
    expect((await act(s.m1, id, "approve")).status).toBe(403);

    const ok = await act(s.vp, id, "approve");
    expect(ok.status).toBe(200);
    expect(ok.body.withdrawal).toMatchObject({ status: "APPROVED", firstApprovalBy: "President", secondApprovalBy: "Vice President" });
    expect((await act(s.vp, id, "approve")).status).toBe(409); // already approved
    expect((await act(s.president, id, "complete", cash())).status).toBe(200);
    expect(await groupFundBalance(prisma, s.groupId)).toBe(500000n);
  });

  it("an administrator paying out their OWN savings always needs the other administrator", async () => {
    const s = await setup(); // dual approval is OFF
    expect((await deposit(s.vp, s.groupId, s.president.id, 100000)).status).toBe(201);

    const r = await payout(s.president, s.groupId, s.president, 50000);
    expect(r.status).toBe(201);
    expect(r.body.withdrawal.status).toBe("PENDING");
    const id = r.body.withdrawal.id as string;

    expect((await act(s.vp, id, "approve")).status).toBe(200);
    const own = await act(s.president, id, "complete", cash());
    expect(own.status).toBe(403);
    expect(own.body.error.code).toBe("CANNOT_COMPLETE_OWN_PAYOUT");
    expect((await act(s.vp, id, "complete", cash())).status).toBe(200);
    expect(await memberSavingsBalance(prisma, s.groupId, s.president.id)).toBe(50000n);
  });

  it("refuses a request that needs a second approver nobody can give", async () => {
    const president = await makeUser("President");
    const groupId = (await createGroup(president)).body.group.id as string;
    const [m1] = await addUsers(groupId, 1);
    await deposit(president, groupId, m1.id, 100000);
    await request(app).put(`/api/groups/${groupId}`).set(bearer(president.token)).send({ requireDualApproval: true }).expect(200);

    const res = await payout(president, groupId, m1, 50000);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("NO_SECOND_APPROVER");
    expect(await prisma.withdrawal.count({ where: { groupId } })).toBe(0);
  });

  it("reject needs a reason and another administrator; cancel is for the requester; both free the reservation", async () => {
    const s = await setup();
    const a = (await payout(s.president, s.groupId, s.m1, 500000)).body.withdrawal.id as string;
    expect((await payout(s.president, s.groupId, s.m1, 100000)).body.error.code).toBe("MEMBER_BALANCE_TOO_LOW"); // all reserved

    expect((await act(s.vp, a, "reject", { reason: "no" })).status).toBe(400);
    const own = await act(s.president, a, "reject", { reason: "Changed my mind about this" });
    expect(own.status).toBe(403);
    expect(own.body.error.code).toBe("CANNOT_REJECT_OWN_REQUEST");
    const rejected = await act(s.vp, a, "reject", { reason: "The member didn't ask for this" });
    expect(rejected.status).toBe(200);
    expect(rejected.body.withdrawal).toMatchObject({ status: "REJECTED", rejectionReason: "The member didn't ask for this" });
    expect(await prisma.notification.count({ where: { userId: s.president.id, type: "WITHDRAWAL_REJECTED" } })).toBe(1);

    const b = (await payout(s.president, s.groupId, s.m1, 500000)).body.withdrawal.id as string; // reservation freed
    expect((await act(s.vp, b, "cancel")).status).toBe(403); // only the requester
    const cancelled = await act(s.president, b, "cancel");
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.withdrawal.status).toBe("CANCELLED");
    expect((await act(s.president, b, "cancel")).status).toBe(409);
    expect((await act(s.vp, a, "complete", cash())).status).toBe(409); // a rejected request can't be completed
    expect(await groupFundBalance(prisma, s.groupId)).toBe(600000n);
  });
});

describe("protecting the money", () => {
  it("a payout can't exceed the member's savings, and approved payouts reserve it", async () => {
    const s = await setup();
    const tooMuch = await payout(s.president, s.groupId, s.m2, 100001);
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.body.error.code).toBe("MEMBER_BALANCE_TOO_LOW");

    expect((await payout(s.president, s.groupId, s.m1, 400000)).status).toBe(201);
    const second = await payout(s.president, s.groupId, s.m1, 200000); // only ₹1,000 is left unreserved
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("MEMBER_BALANCE_TOO_LOW");
    expect((await payout(s.president, s.groupId, s.m1, 100000)).status).toBe(201);
  });

  it("money promised to an approved loan can't be promised again", async () => {
    const s = await setup();
    const apply = await request(app).post(`/api/groups/${s.groupId}/loans`).set(bearer(s.m2.token))
      .send({ principalPaise: 500000, purpose: "Shop inventory", installmentCount: 5 });
    await request(app).post(`/api/loans/${apply.body.loan.id}/approve`).set(bearer(s.president.token)).send({}).expect(200);

    const res = await payout(s.president, s.groupId, s.m1, 200000); // fund ₹6,000 - loan ₹5,000 = ₹1,000
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("INSUFFICIENT_FUND");
    expect((await payout(s.president, s.groupId, s.m1, 100000)).status).toBe(201);
  });

  it("an approved withdrawal reserves money from loan approvals too", async () => {
    const s = await setup();
    expect((await payout(s.president, s.groupId, s.m1, 400000)).status).toBe(201); // reserved
    const apply = await request(app).post(`/api/groups/${s.groupId}/loans`).set(bearer(s.m2.token))
      .send({ principalPaise: 300000, purpose: "Shop inventory", installmentCount: 3 });
    const res = await request(app).post(`/api/loans/${apply.body.loan.id}/approve`).set(bearer(s.president.token)).send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("INSUFFICIENT_FUND"); // ₹6,000 - ₹4,000 = ₹2,000 < ₹3,000
  });

  it("savings that back a live loan can't be paid out", async () => {
    const s = await setup();
    const apply = await request(app).post(`/api/groups/${s.groupId}/loans`).set(bearer(s.m2.token))
      .send({ principalPaise: 100000, purpose: "Shop inventory", installmentCount: 4 });
    const loanId = apply.body.loan.id as string;
    await request(app).post(`/api/loans/${loanId}/approve`).set(bearer(s.president.token)).send({}).expect(200);
    await request(app).post(`/api/loans/${loanId}/disburse`).set(bearer(s.president.token)).send({ method: "CASH", note: "Handed over in cash" }).expect(200);

    const res = await payout(s.president, s.groupId, s.m2, 100); // savings ₹1,000 - ₹1,000 still owed = 0
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("MEMBER_BALANCE_TOO_LOW");
  });

  it("group expenses can only use interest earned, and never touch members' savings", async () => {
    const s = await setup();
    await request(app).put(`/api/groups/${s.groupId}`).set(bearer(s.president.token)).send({ interestMethod: "FLAT", interestRateBps: 1200 }).expect(200);
    expect((await expense(s.president, s.groupId, 100)).body.error.code).toBe("INSUFFICIENT_SURPLUS"); // no interest yet

    const apply = await request(app).post(`/api/groups/${s.groupId}/loans`).set(bearer(s.m2.token))
      .send({ principalPaise: 100000, purpose: "Shop inventory", installmentCount: 4 });
    const loanId = apply.body.loan.id as string;
    await request(app).post(`/api/loans/${loanId}/approve`).set(bearer(s.president.token)).send({}).expect(200);
    await request(app).post(`/api/loans/${loanId}/disburse`).set(bearer(s.president.token)).send({ method: "CASH", note: "Handed over in cash" }).expect(200);
    await request(app).post(`/api/loans/${loanId}/repayments`).set(bearer(s.president.token)).send({
      amountPaise: 26000, method: "CASH", evidenceNote: "Cash received at the meeting", clientRequestId: nid(),
    }).expect(201); // ₹260 = ₹250 principal + ₹10 interest

    expect((await expense(s.president, s.groupId, 1001)).body.error.code).toBe("INSUFFICIENT_SURPLUS"); // only ₹10.00 earned
    const ok = await expense(s.president, s.groupId, 1000);
    expect(ok.status).toBe(201);
    expect(ok.body.withdrawal).toMatchObject({ kind: "GROUP_EXPENSE", status: "APPROVED", beneficiary: null });
    expect((await expense(s.president, s.groupId, 100)).body.error.code).toBe("INSUFFICIENT_SURPLUS"); // reserved already

    const before = await groupFundBalance(prisma, s.groupId);
    expect((await act(s.vp, ok.body.withdrawal.id, "complete", cash())).status).toBe(200);
    expect(await groupFundBalance(prisma, s.groupId)).toBe(before - 1000n);
    expect(await memberSavingsBalance(prisma, s.groupId, s.m1.id)).toBe(500000n); // savings untouched
    expect((await integrity(s)).body.ok).toBe(true);
  });
});

describe("leaving the group", () => {
  it("a member is blocked while savings remain, and free to leave once paid out", async () => {
    const s = await setup();
    const blocked = await request(app).post(`/api/groups/${s.groupId}/leave`).set(bearer(s.m1.token));
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("SAVINGS_NOT_PAID_OUT");

    const id = (await payout(s.president, s.groupId, s.m1, 500000)).body.withdrawal.id as string;
    expect((await request(app).post(`/api/groups/${s.groupId}/leave`).set(bearer(s.m1.token))).status).toBe(409); // approved is not sent
    expect((await act(s.vp, id, "complete", bank())).status).toBe(200);

    const left = await request(app).post(`/api/groups/${s.groupId}/leave`).set(bearer(s.m1.token));
    expect(left.status).toBe(200);
    expect((await prisma.groupMember.findFirstOrThrow({ where: { groupId: s.groupId, userId: s.m1.id } })).status).toBe("LEFT");
    expect((await integrity(s)).body.ok).toBe(true);
  });
});

describe("withdrawal report", () => {
  it("adds up completed, reserved and rejected withdrawals; administrators only", async () => {
    const s = await setup();
    const a = (await payout(s.president, s.groupId, s.m1, 200000)).body.withdrawal.id as string;
    await act(s.vp, a, "complete", cash()).then((r) => expect(r.status).toBe(200));
    expect((await payout(s.president, s.groupId, s.m1, 100000)).status).toBe(201); // approved, not sent
    const c = (await payout(s.president, s.groupId, s.m2, 50000)).body.withdrawal.id as string;
    await act(s.vp, c, "reject", { reason: "Member wants to keep saving" }).then((r) => expect(r.status).toBe(200));

    const res = await request(app).get(`/api/groups/${s.groupId}/withdrawals/report`).set(bearer(s.vp.token));
    expect(res.status).toBe(200);
    expect(res.body.summary).toMatchObject({
      completedPaise: 200000, payoutsCompletedPaise: 200000, expensesCompletedPaise: 0,
      awaitingTransferCount: 1, awaitingTransferPaise: 100000, rejectedCount: 1, awaitingApprovalCount: 0,
    });
    expect(res.body.items).toHaveLength(3);
    expect((await request(app).get(`/api/groups/${s.groupId}/withdrawals/report`).set(bearer(s.m1.token))).status).toBe(403);
  });
});
