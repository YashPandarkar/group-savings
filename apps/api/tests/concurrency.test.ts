import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { prisma } from "../src/config/prisma";
import { groupFundBalance } from "../src/lib/ledger";
import {
  signSimulatorCheckout, signSimulatorWebhook, simulatorPay, simulatorReset,
} from "../src/lib/providers/simulator";
import { reconcilePayments } from "../src/modules/payments/payments.reconcile";
import { app } from "./helpers";
import { addUsers, bearer, createGroup, makeUser, type TestUser } from "./groupHelpers";

let seq = 0;
const nid = () => `cc-${Date.now()}-${++seq}`;
beforeEach(() => simulatorReset());

// President + two members; Member 2 has ₹5,000 in the fund (as savings).
async function setup() {
  const president = await makeUser("President");
  const groupId = (await createGroup(president)).body.group.id as string;
  const [m1, m2] = await addUsers(groupId, 2);
  await prisma.groupMember.updateMany({ where: { groupId }, data: { joinedAt: new Date(Date.now() - 62 * 86_400_000) } });
  const dep = await request(app)
    .post(`/api/groups/${groupId}/deposits/manual`)
    .set(bearer(president.token))
    .send({
      userId: m2.id, purpose: "ADDITIONAL_DEPOSIT", amountPaise: 500000, method: "CASH",
      evidenceNote: "Cash received at the meeting", clientRequestId: nid(),
    });
  expect(dep.status).toBe(201);
  return { president, m1, m2, groupId };
}
type S = Awaited<ReturnType<typeof setup>>;

const apply = (u: TestUser, groupId: string, principalPaise: number) =>
  request(app).post(`/api/groups/${groupId}/loans`).set(bearer(u.token))
    .send({ principalPaise, purpose: "Shop inventory", installmentCount: 4 });
const act = (u: TestUser, loanId: string, action: string, body: Record<string, unknown> = {}) =>
  request(app).post(`/api/loans/${loanId}/${action}`).set(bearer(u.token)).send(body);
const repay = (u: TestUser, loanId: string, amountPaise: number) =>
  act(u, loanId, "repayments", {
    amountPaise, method: "CASH", evidenceNote: "Cash received at the meeting", clientRequestId: nid(),
  });
const payout = (u: TestUser, groupId: string, beneficiary: TestUser, amountPaise: number, purpose: string) =>
  request(app).post(`/api/groups/${groupId}/withdrawals`).set(bearer(u.token))
    .send({ kind: "MEMBER_PAYOUT", beneficiaryUserId: beneficiary.id, amountPaise, purpose });
const integrity = (s: S) =>
  request(app).get(`/api/groups/${s.groupId}/reports/integrity`).set(bearer(s.president.token));

const statuses = (...rs: { status: number }[]) => rs.map((r) => r.status).sort();

describe("simultaneous requests: exactly one wins, the books stay balanced", () => {
  it("two different loan applications from one member at the same moment", async () => {
    const s = await setup();
    const [a, b] = await Promise.all([apply(s.m1, s.groupId, 100000), apply(s.m1, s.groupId, 200000)]);
    expect(statuses(a, b)).toEqual([201, 409]);
    expect([a, b].find((r) => r.status === 409)!.body.error.code).toBe("HAS_OPEN_LOAN");
    expect(await prisma.loan.count({ where: { groupId: s.groupId, userId: s.m1.id } })).toBe(1);
  });

  it("two loans approved at once can't both be funded from the same money", async () => {
    const s = await setup(); // fund ₹5,000
    const a = (await apply(s.m1, s.groupId, 300000)).body.loan.id as string;
    const b = (await apply(s.m2, s.groupId, 300000)).body.loan.id as string;
    const [x, y] = await Promise.all([act(s.president, a, "approve"), act(s.president, b, "approve")]);
    expect(statuses(x, y)).toEqual([200, 409]);
    expect([x, y].find((r) => r.status === 409)!.body.error.code).toBe("INSUFFICIENT_FUND");
    expect(await prisma.loan.count({ where: { groupId: s.groupId, status: "APPROVED" } })).toBe(1);
  });

  it("disbursing the same loan twice at once moves the money once", async () => {
    const s = await setup();
    const id = (await apply(s.m1, s.groupId, 100000)).body.loan.id as string;
    expect((await act(s.president, id, "approve")).status).toBe(200);
    const body = { method: "CASH", note: "Handed over in cash" };
    const [a, b] = await Promise.all([act(s.president, id, "disburse", body), act(s.president, id, "disburse", body)]);
    expect(statuses(a, b)).toEqual([200, 409]);
    expect(await prisma.ledgerJournal.count({ where: { groupId: s.groupId, type: "LOAN_DISBURSEMENT" } })).toBe(1);
    expect(await prisma.loanInstallment.count({ where: { loanId: id } })).toBe(4);
    expect(await groupFundBalance(prisma, s.groupId)).toBe(400000n);
    expect((await integrity(s)).body.ok).toBe(true);
  });

  it("two repayments that together exceed the balance: only one is accepted", async () => {
    const s = await setup();
    const id = (await apply(s.m1, s.groupId, 100000)).body.loan.id as string;
    await act(s.president, id, "approve").then((r) => expect(r.status).toBe(200));
    await act(s.president, id, "disburse", { method: "CASH", note: "Handed over in cash" }).then((r) => expect(r.status).toBe(200));

    const [a, b] = await Promise.all([repay(s.president, id, 60000), repay(s.president, id, 60000)]);
    expect(statuses(a, b)).toEqual([201, 409]);
    expect([a, b].find((r) => r.status === 409)!.body.error.code).toBe("AMOUNT_EXCEEDS_OUTSTANDING");
    expect(await groupFundBalance(prisma, s.groupId)).toBe(460000n); // 5,000 - 1,000 lent + 600 repaid, once
    expect((await integrity(s)).body.ok).toBe(true);
  });

  it("two payout requests competing for the same savings: only one is reserved", async () => {
    const s = await setup();
    const [a, b] = await Promise.all([
      payout(s.president, s.groupId, s.m2, 300000, "Payout number one"),
      payout(s.president, s.groupId, s.m2, 300000, "Payout number two"),
    ]);
    expect(statuses(a, b)).toEqual([201, 409]);
    const code = [a, b].find((r) => r.status === 409)!.body.error.code as string;
    expect(["INSUFFICIENT_FUND", "MEMBER_BALANCE_TOO_LOW"]).toContain(code);
    expect(await prisma.withdrawal.count({ where: { groupId: s.groupId } })).toBe(1);
  });

  it("verify, webhook and reconciliation racing for one payment credit it exactly once", async () => {
    const s = await setup();
    const before = await prisma.ledgerJournal.count({ where: { groupId: s.groupId } });
    const order = await request(app)
      .post("/api/payments/create-order")
      .set(bearer(s.m1.token))
      .set("Idempotency-Key", nid())
      .send({ groupId: s.groupId, purpose: "ADDITIONAL_DEPOSIT", amountPaise: 20000 });
    expect(order.status).toBe(201);
    const providerOrderId = order.body.order.providerOrderId as string;
    const pay = simulatorPay(providerOrderId, "captured");
    const eventBody = JSON.stringify({
      event: "payment.captured",
      payload: { payment: { entity: { id: pay.id, order_id: providerOrderId } } },
    });

    const [verify, hook, rec] = await Promise.all([
      request(app).post("/api/payments/verify").set(bearer(s.m1.token)).send({
        razorpay_order_id: providerOrderId,
        razorpay_payment_id: pay.id,
        razorpay_signature: signSimulatorCheckout(providerOrderId, pay.id),
      }),
      request(app)
        .post("/api/payments/webhook")
        .set("Content-Type", "application/json")
        .set("X-Razorpay-Signature", signSimulatorWebhook(eventBody))
        .set("X-Razorpay-Event-Id", nid())
        .send(eventBody),
      reconcilePayments({ groupId: s.groupId, olderThanMinutes: 0 }),
    ]);

    expect(verify.status).toBe(200);
    expect(hook.status).toBe(200);
    expect(rec.errors).toBe(0);
    expect(await prisma.paymentTransaction.count({ where: { groupId: s.groupId, providerPaymentId: pay.id } })).toBe(1);
    expect(await prisma.ledgerJournal.count({ where: { groupId: s.groupId } })).toBe(before + 1);
    expect(await groupFundBalance(prisma, s.groupId)).toBe(520000n);
    expect((await integrity(s)).body.ok).toBe(true);
  });
});

describe("idempotency keys", () => {
  it("two members may use the same Idempotency-Key: keys are per person", async () => {
    const s = await setup();
    const key = nid();
    const create = (u: TestUser) =>
      request(app).post("/api/payments/create-order").set(bearer(u.token)).set("Idempotency-Key", key)
        .send({ groupId: s.groupId, purpose: "ADDITIONAL_DEPOSIT", amountPaise: 5000 });
    const [a, b] = await Promise.all([create(s.m1), create(s.m2)]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.order.id).not.toBe(b.body.order.id);
  });
});
