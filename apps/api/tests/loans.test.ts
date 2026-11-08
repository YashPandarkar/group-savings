import { describe, expect, it } from "vitest";
import request from "supertest";
import { prisma } from "../src/config/prisma";
import { app } from "./helpers";
import { addMember, addUsers, bearer, createGroup, makeUser, type TestUser } from "./groupHelpers";
import { getAccountId, groupFundBalance } from "../src/lib/ledger";

let seq = 0;
const reqId = () => `ln-${Date.now()}-${++seq}`;
const utr = () => `LN${Date.now()}${++seq}`;

const FLAT = { interestMethod: "FLAT", interestRateBps: 1200 }; // 12% a year

// President, VP, two members; the fund starts with ₹5,000 (from Member 2).
async function setup(policy?: Record<string, unknown>) {
  const president = await makeUser("President");
  const groupId = (await createGroup(president)).body.group.id as string;
  const vp = await makeUser("Vice President");
  await addMember(groupId, vp.id, "VICE_PRESIDENT");
  const [m1, m2] = await addUsers(groupId, 2); // "Member 1", "Member 2"
  await request(app)
    .post(`/api/groups/${groupId}/deposits/manual`)
    .set(bearer(president.token))
    .send({
      userId: m2.id, purpose: "ADDITIONAL_DEPOSIT", amountPaise: 500000, method: "CASH",
      evidenceNote: "Cash received at the meeting", clientRequestId: reqId(),
    })
    .expect(201);
  if (policy) await request(app).put(`/api/groups/${groupId}`).set(bearer(president.token)).send(policy).expect(200);
  return { president, vp, m1, m2, groupId };
}
type S = Awaited<ReturnType<typeof setup>>;

const apply = (u: TestUser, groupId: string, body: Record<string, unknown> = {}) =>
  request(app)
    .post(`/api/groups/${groupId}/loans`)
    .set(bearer(u.token))
    .send({ principalPaise: 100000, purpose: "Medical expenses", installmentCount: 4, ...body });
const act = (u: TestUser, loanId: string, action: string, body: Record<string, unknown> = {}) =>
  request(app).post(`/api/loans/${loanId}/${action}`).set(bearer(u.token)).send(body);
const getLoan = (u: TestUser, loanId: string) => request(app).get(`/api/loans/${loanId}`).set(bearer(u.token));
const disburseBody = () => ({ method: "BANK_TRANSFER", reference: utr(), note: "Transferred from the group account" });
const repay = (u: TestUser, loanId: string, amountPaise: number, extra: Record<string, unknown> = {}) =>
  act(u, loanId, "repayments", {
    amountPaise, method: "CASH", evidenceNote: "Cash received at the meeting", clientRequestId: reqId(), ...extra,
  });

async function disbursedLoan(s: S, borrower: TestUser = s.m1, body: Record<string, unknown> = {}) {
  const a = await apply(borrower, s.groupId, body);
  expect(a.status).toBe(201);
  const id = a.body.loan.id as string;
  expect((await act(s.president, id, "approve")).status).toBe(200);
  expect((await act(s.president, id, "disburse", disburseBody())).status).toBe(200);
  return id;
}

async function ledgerBalance(groupId: string, code: string, userId: string | null, normal: "DEBIT" | "CREDIT") {
  const accountId = await getAccountId(prisma, groupId, code, userId ?? undefined);
  const sum = async (direction: "DEBIT" | "CREDIT") =>
    (await prisma.ledgerEntry.aggregate({ _sum: { amountPaise: true }, where: { accountId, direction } }))._sum.amountPaise ?? 0n;
  const [d, c] = await Promise.all([sum("DEBIT"), sum("CREDIT")]);
  return normal === "DEBIT" ? d - c : c - d;
}

const integrity = (s: S) =>
  request(app).get(`/api/groups/${s.groupId}/reports/integrity`).set(bearer(s.president.token));

describe("applying", () => {
  it("copies the group's terms (the member can't set them) and shows the schedule up front", async () => {
    const s = await setup(FLAT);
    const res = await apply(s.m1, s.groupId, { interestMethod: "NONE", interestRateBps: 0 }); // ignored
    expect(res.status).toBe(201);
    const loan = res.body.loan;
    expect(loan.status).toBe("PENDING");
    expect(loan.interestMethod).toBe("FLAT");
    expect(loan.interestRateBps).toBe(1200);
    expect(loan.policy).toContain("12.00% per year");
    expect(loan.totalRepayablePaise).toBe(104000);
    expect(loan.schedulePreview).toHaveLength(4);
    expect(loan.schedulePreview[0]).toMatchObject({ principalPaise: 25000, interestPaise: 1000, totalPaise: 26000 });
    expect(loan.installments).toHaveLength(0);
    expect(await prisma.notification.count({ where: { userId: s.president.id, type: "LOAN_APPLIED" } })).toBe(1);
    expect(await prisma.notification.count({ where: { userId: s.vp.id, type: "LOAN_APPLIED" } })).toBe(1);
  });

  it("allows one open loan per member; an immediate identical retry is a replay", async () => {
    const s = await setup();
    const a = await apply(s.m1, s.groupId);
    const b = await apply(s.m1, s.groupId);
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.replayed).toBe(true);
    expect(b.body.loan.id).toBe(a.body.loan.id);

    const other = await apply(s.m1, s.groupId, { principalPaise: 200000 });
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe("HAS_OPEN_LOAN");
    expect(await prisma.loan.count({ where: { groupId: s.groupId } })).toBe(1);
  });

  it("validates input", async () => {
    const s = await setup();
    const bad = async (body: Record<string, unknown>) => (await apply(s.m1, s.groupId, body)).status;
    expect(await bad({ principalPaise: 5000 })).toBe(400); // under ₹100
    expect(await bad({ principalPaise: 150000.5 })).toBe(400);
    expect(await bad({ purpose: "x" })).toBe(400);
    expect(await bad({ installmentCount: 0 })).toBe(400);
    expect(await bad({ installmentCount: 61 })).toBe(400); // monthly max 60
    expect(await bad({ principalPaise: 10000, installmentCount: 60 })).toBe(201); // each installment ≥ ₹1
    expect(await prisma.loan.count({ where: { groupId: s.groupId } })).toBe(1);
  });

  it("the quote uses the group's current policy", async () => {
    const s = await setup(FLAT);
    const res = await request(app)
      .get(`/api/groups/${s.groupId}/loans/quote?principalPaise=100000&installmentCount=4`)
      .set(bearer(s.m1.token));
    expect(res.status).toBe(200);
    expect(res.body.totalRepayablePaise).toBe(104000);
    expect(res.body.totalInterestPaise).toBe(4000);
    expect(res.body.installments).toHaveLength(4);
  });
});

describe("review, approval and who may decide", () => {
  it("members can't decide; the VP reviews but can't approve; the President approves once", async () => {
    const s = await setup();
    const id = (await apply(s.m1, s.groupId)).body.loan.id as string;

    expect((await act(s.m1, id, "approve")).status).toBe(403);
    expect((await act(s.m2, id, "review")).status).toBe(403);

    const reviewed = await act(s.vp, id, "review", { note: "Looks fine" });
    expect(reviewed.status).toBe(200);
    expect(reviewed.body.loan.status).toBe("UNDER_REVIEW");

    const vpTry = await act(s.vp, id, "approve");
    expect(vpTry.status).toBe(403);
    expect(vpTry.body.error.code).toBe("FORBIDDEN");

    const ok = await act(s.president, id, "approve");
    expect(ok.status).toBe(200);
    expect(ok.body.loan.status).toBe("APPROVED");
    expect(ok.body.loan.totalRepayablePaise).toBe(100000);
    expect((await act(s.president, id, "approve")).status).toBe(409);
    expect(await prisma.notification.count({ where: { userId: s.m1.id, type: "LOAN_APPROVED" } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { groupId: s.groupId, action: "LOAN_APPROVED" } })).toBe(1);
  });

  it("the President's own loan is decided by the Vice President, and the President can't record its repayments", async () => {
    const s = await setup();
    const id = (await apply(s.president, s.groupId)).body.loan.id as string;

    const own = await act(s.president, id, "approve");
    expect(own.status).toBe(403);
    expect(own.body.error.code).toBe("CANNOT_DECIDE_OWN_LOAN");

    expect((await act(s.vp, id, "approve")).status).toBe(200);
    expect((await act(s.vp, id, "disburse", disburseBody())).status).toBe(200);

    const mine = await repay(s.president, id, 25000);
    expect(mine.status).toBe(403);
    expect(mine.body.error.code).toBe("CANNOT_RECORD_OWN_REPAYMENT");
    expect((await repay(s.vp, id, 25000)).status).toBe(201);
  });

  it("approval can't promise money that is already promised", async () => {
    const s = await setup(); // fund ₹5,000
    const a = (await apply(s.m1, s.groupId, { principalPaise: 300000 })).body.loan.id as string;
    const b = (await apply(s.m2, s.groupId, { principalPaise: 300000 })).body.loan.id as string;

    expect((await act(s.president, a, "approve")).status).toBe(200);
    const second = await act(s.president, b, "approve");
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("INSUFFICIENT_FUND");

    const tooBig = await apply(s.vp, s.groupId, { principalPaise: 900000 });
    const big = await act(s.president, tooBig.body.loan.id, "approve");
    expect(big.body.error.code).toBe("INSUFFICIENT_FUND");
  });

  it("rejecting needs a reason; the applicant may apply again; withdrawing works and is private", async () => {
    const s = await setup();
    const id = (await apply(s.m1, s.groupId)).body.loan.id as string;

    expect((await act(s.president, id, "reject", { reason: "no" })).status).toBe(400);
    const rejected = await act(s.president, id, "reject", { reason: "The group can't lend this much now" });
    expect(rejected.status).toBe(200);
    expect(rejected.body.loan.status).toBe("REJECTED");
    expect(rejected.body.loan.rejectionReason).toContain("can't lend");

    const again = await apply(s.m1, s.groupId);
    expect(again.status).toBe(201);
    const id2 = again.body.loan.id as string;
    expect((await act(s.m2, id2, "cancel")).status).toBe(404); // not your loan
    const cancelled = await act(s.m1, id2, "cancel");
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.loan.status).toBe("REJECTED");
    expect(cancelled.body.loan.rejectionReason).toContain("Withdrawn");
  });
});

describe("disbursement", () => {
  it("posts to the ledger, builds the schedule, and can't happen twice", async () => {
    const s = await setup(FLAT);
    const id = (await apply(s.m1, s.groupId)).body.loan.id as string;

    expect((await act(s.president, id, "disburse", disburseBody())).status).toBe(409); // not approved yet
    await act(s.president, id, "approve");
    expect((await act(s.president, id, "disburse", { method: "UPI", note: "Sent via UPI" })).status).toBe(400); // needs a reference
    expect((await act(s.vp, id, "disburse", disburseBody())).status).toBe(403);

    const d = await act(s.president, id, "disburse", disburseBody());
    expect(d.status).toBe(200);
    const loan = d.body.loan;
    expect(loan.status).toBe("DISBURSED");
    expect(loan.installments).toHaveLength(4);
    expect(loan.installments.reduce((n: number, i: { totalDuePaise: number }) => n + i.totalDuePaise, 0)).toBe(104000);
    const dates = loan.installments.map((i: { dueDate: string }) => new Date(i.dueDate).getTime());
    expect(dates[0]).toBeGreaterThan(Date.now());
    expect([...dates].sort((a, b) => a - b)).toEqual(dates);
    expect(loan.firstDueDate).toBe(loan.installments[0].dueDate);

    expect(await groupFundBalance(prisma, s.groupId)).toBe(400000n);
    expect(await ledgerBalance(s.groupId, "LOANS_RECEIVABLE", s.m1.id, "DEBIT")).toBe(100000n);
    expect(await ledgerBalance(s.groupId, "MEMBER_SAVINGS", s.m1.id, "CREDIT")).toBe(0n); // savings untouched

    const again = await act(s.president, id, "disburse", disburseBody());
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("ALREADY_DISBURSED");

    const txs = await request(app).get(`/api/groups/${s.groupId}/transactions?type=LOAN_DISBURSEMENT`).set(bearer(s.president.token));
    expect(txs.body.total).toBe(1);
    expect(txs.body.items[0]).toMatchObject({ bankDeltaPaise: -100000, memberName: "Member 1" });
    expect((await integrity(s)).body.ok).toBe(true);
  });

  it("a cash disbursement needs no reference", async () => {
    const s = await setup();
    const id = (await apply(s.m1, s.groupId)).body.loan.id as string;
    await act(s.president, id, "approve");
    const d = await act(s.president, id, "disburse", { method: "CASH", note: "Handed over in cash" });
    expect(d.status).toBe(200);
    expect(d.body.loan.disbursementRef).toBe("CASH");
  });
});

describe("repayments", () => {
  it("full lifecycle: installments, partial payments, multi-installment payments, completion", async () => {
    const s = await setup(FLAT);
    const id = await disbursedLoan(s);

    expect((await repay(s.m1, id, 26000)).status).toBe(403); // members can't record

    const r1 = await repay(s.president, id, 26000);
    expect(r1.status).toBe(201);
    expect(r1.body.loan.status).toBe("ACTIVE");
    expect(r1.body.loan.installments[0].status).toBe("PAID");
    expect(r1.body.loan.outstandingPaise).toBe(78000);
    expect(await groupFundBalance(prisma, s.groupId)).toBe(426000n);
    expect(await ledgerBalance(s.groupId, "INTEREST_INCOME", null, "CREDIT")).toBe(1000n);
    expect(await ledgerBalance(s.groupId, "LOANS_RECEIVABLE", s.m1.id, "DEBIT")).toBe(75000n);

    const r2 = await repay(s.president, id, 10000); // part of installment 2: interest first
    expect(r2.body.loan.status).toBe("PARTIALLY_PAID");
    expect(r2.body.loan.installments[1]).toMatchObject({ paidPaise: 10000, interestPaidPaise: 1000, principalPaidPaise: 9000 });

    const r3 = await repay(s.president, id, 24000); // finishes installment 2, starts 3
    expect(r3.body.loan.installments[1].status).toBe("PAID");
    expect(r3.body.loan.installments[2]).toMatchObject({ paidPaise: 8000, status: "PARTIALLY_PAID" });
    expect(await prisma.loanRepayment.count({ where: { loanId: id } })).toBe(4);

    const over = await repay(s.president, id, 44001); // outstanding is exactly 44000
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe("AMOUNT_EXCEEDS_OUTSTANDING");

    const last = await repay(s.president, id, 44000);
    expect(last.status).toBe(201);
    expect(last.body.loan.status).toBe("COMPLETED");
    expect(last.body.loan.outstandingPaise).toBe(0);
    expect(await groupFundBalance(prisma, s.groupId)).toBe(504000n);
    expect(await ledgerBalance(s.groupId, "INTEREST_INCOME", null, "CREDIT")).toBe(4000n);
    expect(await ledgerBalance(s.groupId, "LOANS_RECEIVABLE", s.m1.id, "DEBIT")).toBe(0n);

    expect((await repay(s.president, id, 100)).body.error.code).toBe("LOAN_NOT_ACTIVE");
    const history = await request(app).get(`/api/loans/${id}/repayments`).set(bearer(s.m1.token));
    expect(history.body.repayments).toHaveLength(6);
    expect((await integrity(s)).body.ok).toBe(true);

    // Done and dusted: the member is free to leave once their savings are paid out (Phase 10).
    expect((await prisma.loan.findUniqueOrThrow({ where: { id } })).status).toBe("COMPLETED");
  });

  it("honours the group's partial-payment rule", async () => {
    const s = await setup({ ...FLAT, allowPartialRepayment: false });
    const id = await disbursedLoan(s);
    const part = await repay(s.president, id, 10000);
    expect(part.status).toBe(409);
    expect(part.body.error.code).toBe("PARTIAL_PAYMENT_NOT_ALLOWED");
    expect((await repay(s.president, id, 26000)).status).toBe(201);
    expect(await prisma.loanRepayment.count({ where: { loanId: id } })).toBe(1); // the refused one left nothing
  });

  it("honours the group's early-repayment rule", async () => {
    const s = await setup({ allowEarlyRepayment: false });
    const id = await disbursedLoan(s);
    const early = await repay(s.president, id, 25000);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe("EARLY_REPAYMENT_NOT_ALLOWED");

    await prisma.loanInstallment.updateMany({ where: { loanId: id, number: 1 }, data: { dueDate: new Date(Date.now() - 86_400_000) } });
    expect((await repay(s.president, id, 25000)).status).toBe(201);
  });

  it("a retry is not applied twice, even when two arrive at once", async () => {
    const s = await setup();
    const id = await disbursedLoan(s);
    const body = { clientRequestId: reqId() };
    const a = await repay(s.president, id, 25000, body);
    const b = await repay(s.president, id, 25000, body);
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.replayed).toBe(true);
    expect(await prisma.ledgerJournal.count({ where: { groupId: s.groupId, type: "LOAN_REPAYMENT" } })).toBe(1);

    const par = { clientRequestId: reqId() };
    const [x, y] = await Promise.all([repay(s.president, id, 25000, par), repay(s.vp, id, 25000, par)]);
    expect([x.status, y.status].sort()).toEqual([200, 201]);
    expect(await groupFundBalance(prisma, s.groupId)).toBe(450000n); // 400000 + two payments, not three
  });

  it("the same bank reference can't be recorded twice", async () => {
    const s = await setup();
    const id = await disbursedLoan(s);
    const ref = utr();
    expect((await repay(s.president, id, 25000, { method: "UPI", paymentReference: ref })).status).toBe(201);
    const dup = await repay(s.president, id, 25000, { method: "UPI", paymentReference: ref.toLowerCase() });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("DUPLICATE_PAYMENT_REFERENCE");
  });
});

describe("overdue", () => {
  it("a missed due date makes the loan OVERDUE until it is paid", async () => {
    const s = await setup(FLAT);
    const id = await disbursedLoan(s);
    await prisma.loanInstallment.updateMany({ where: { loanId: id, number: 1 }, data: { dueDate: new Date(Date.now() - 86_400_000) } });

    const late = await getLoan(s.president, id);
    expect(late.body.loan.status).toBe("OVERDUE");
    expect(late.body.loan.installments[0]).toMatchObject({ status: "OVERDUE", overdue: true });
    expect(late.body.loan.overdueAmountPaise).toBe(26000);
    expect((await getLoan(s.m1, id)).body.loan.status).toBe("OVERDUE"); // the borrower sees it too

    const report = await request(app).get(`/api/groups/${s.groupId}/loans/outstanding`).set(bearer(s.president.token));
    expect(report.body.summary).toMatchObject({ overdueLoans: 1, overduePaise: 26000 });

    const paid = await repay(s.president, id, 26000);
    expect(paid.body.loan.status).toBe("ACTIVE");
    expect(paid.body.loan.overdueAmountPaise).toBe(0);
  });
});

describe("visibility and isolation", () => {
  it("members see only their own loans; another group sees nothing", async () => {
    const s = await setup();
    const other = await setup();
    const id1 = (await apply(s.m1, s.groupId)).body.loan.id as string;
    await apply(s.m2, s.groupId);

    expect((await getLoan(s.m1, id1)).status).toBe(200);
    expect((await getLoan(s.m2, id1)).status).toBe(404);
    expect((await getLoan(s.president, id1)).status).toBe(200);
    expect((await getLoan(s.vp, id1)).status).toBe(200);

    const mine = await request(app).get(`/api/groups/${s.groupId}/loans`).set(bearer(s.m1.token));
    expect(mine.body.total).toBe(1);
    expect(mine.body.items[0].installments).toBeUndefined();
    const all = await request(app).get(`/api/groups/${s.groupId}/loans`).set(bearer(s.president.token));
    expect(all.body.total).toBe(2);
    expect((await request(app).get(`/api/groups/${s.groupId}/loans?status=NOPE`).set(bearer(s.president.token))).status).toBe(400);

    // GROUP ISOLATION: another group's President can't read or act on it, by any path.
    expect((await getLoan(other.president, id1)).status).toBe(404);
    expect((await act(other.president, id1, "approve")).status).toBe(404);
    expect((await act(other.president, id1, "disburse", disburseBody())).status).toBe(404);
    expect((await repay(other.president, id1, 25000)).status).toBe(404);
    expect((await request(app).get(`/api/groups/${other.groupId}/loans/${id1}`).set(bearer(other.president.token))).status).toBe(404);
    expect((await request(app).get(`/api/groups/${s.groupId}/loans`).set(bearer(other.president.token))).status).toBe(404);
    expect((await getLoan(s.m1, "does-not-exist")).status).toBe(404);
    expect((await request(app).get(`/api/loans/${id1}`)).status).toBe(401);
  });
});

describe("outstanding report", () => {
  it("adds up principal, interest and what is still owed; admins only", async () => {
    const s = await setup(FLAT);
    const id = await disbursedLoan(s);
    await repay(s.president, id, 10000); // 1000 interest + 9000 principal

    const res = await request(app).get(`/api/groups/${s.groupId}/loans/outstanding`).set(bearer(s.vp.token));
    expect(res.status).toBe(200);
    expect(res.body.summary).toMatchObject({
      loansDisbursedPaise: 100000,
      repaidPaise: 10000,
      principalRepaidPaise: 9000,
      interestEarnedPaise: 1000,
      outstandingPrincipalPaise: 91000,
      outstandingTotalPaise: 94000,
      activeLoans: 1,
      overdueLoans: 0,
    });
    expect(res.body.items).toHaveLength(1);
    expect((await request(app).get(`/api/groups/${s.groupId}/loans/outstanding`).set(bearer(s.m1.token))).status).toBe(403);
  });
});
