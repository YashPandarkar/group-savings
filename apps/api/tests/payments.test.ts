import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { prisma } from "../src/config/prisma";
import { app } from "./helpers";
import { addUsers, bearer, createGroup, makeUser, type TestUser } from "./groupHelpers";
import { getAccountId, groupFundBalance } from "../src/lib/ledger";
import { memberSavingsBalance } from "../src/lib/ledgerAccounts";
import {
  signSimulatorCheckout, signSimulatorWebhook, simulatorPay, simulatorReset, simulatorUpdate,
} from "../src/lib/providers/simulator";
import { reconcilePayments } from "../src/modules/payments/payments.reconcile";
import { addMember } from "./groupHelpers";

let seq = 0;
const nextKey = () => `idem-${Date.now()}-${++seq}`;
const nextEvent = () => `evt_${Date.now()}_${++seq}`;

beforeEach(() => simulatorReset());

// President, VP, two members who "joined two months ago" (so monthly contributions exist).
async function setup() {
  const president = await makeUser("President");
  const groupId = (await createGroup(president)).body.group.id as string;
  const vp = await makeUser("Vice President");
  await addMember(groupId, vp.id, "VICE_PRESIDENT");
  const [m1, m2] = await addUsers(groupId, 2);
  await prisma.groupMember.updateMany({ where: { groupId }, data: { joinedAt: new Date(Date.now() - 62 * 86_400_000) } });
  return { president, vp, m1, m2, groupId };
}
type S = Awaited<ReturnType<typeof setup>>;

const createOrder = (u: TestUser, body: Record<string, unknown>, key = nextKey()) =>
  request(app).post("/api/payments/create-order").set(bearer(u.token)).set("Idempotency-Key", key).send(body);
const monthly = (u: TestUser, groupId: string, amountPaise = 20000) =>
  createOrder(u, { groupId, purpose: "MONTHLY_DEPOSIT", amountPaise });

const paymentEvent = (type: string, paymentId: string, orderId: string) => ({
  event: type,
  payload: { payment: { entity: { id: paymentId, order_id: orderId } } },
});

const webhook = (event: object, opts: { signature?: string; eventId?: string; body?: string } = {}) => {
  const body = opts.body ?? JSON.stringify(event);
  return request(app)
    .post("/api/payments/webhook")
    .set("Content-Type", "application/json")
    .set("X-Razorpay-Signature", opts.signature ?? signSimulatorWebhook(body))
    .set("X-Razorpay-Event-Id", opts.eventId ?? nextEvent())
    .send(body);
};

async function payAndNotify(providerOrderId: string, status: "captured" | "failed" | "authorized" = "captured") {
  const pay = simulatorPay(providerOrderId, status);
  const type = status === "captured" ? "payment.captured" : status === "failed" ? "payment.failed" : "payment.authorized";
  const res = await webhook(paymentEvent(type, pay.id, providerOrderId));
  return { pay, res };
}

const manual = (actor: TestUser, groupId: string, body: Record<string, unknown>) =>
  request(app)
    .post(`/api/groups/${groupId}/deposits/manual`)
    .set(bearer(actor.token))
    .send({
      purpose: "MONTHLY_DEPOSIT", amountPaise: 20000, method: "CASH",
      evidenceNote: "Cash received at the meeting", clientRequestId: `pm-${Date.now()}-${++seq}`, ...body,
    });

const contributionOf = (groupId: string, userId: string) =>
  prisma.contribution.findFirstOrThrow({ where: { groupId, userId } });
const orderRow = (id: string) => prisma.paymentOrder.findUniqueOrThrow({ where: { id } });
const integrity = (s: S) =>
  request(app).get(`/api/groups/${s.groupId}/reports/integrity`).set(bearer(s.president.token));

async function creditSum(groupId: string, code: string) {
  const accountId = await getAccountId(prisma, groupId, code);
  const r = await prisma.ledgerEntry.aggregate({ _sum: { amountPaise: true }, where: { accountId, direction: "CREDIT" } });
  return r._sum.amountPaise ?? 0n;
}

describe("creating orders", () => {
  it("validates on the server and returns only public checkout values", async () => {
    const s = await setup();
    const res = await monthly(s.m1, s.groupId);
    expect(res.status).toBe(201);
    expect(res.body.order).toMatchObject({ status: "CREATED", amountPaise: 20000, purpose: "MONTHLY_DEPOSIT" });
    expect(res.body.checkout.orderId).toMatch(/^order_sim_/);
    expect(res.body.checkout.key).toBe("simulator");
    expect(JSON.stringify(res.body).toLowerCase()).not.toContain("secret");
    expect((await orderRow(res.body.order.id)).contributionId).not.toBeNull();
    expect(await prisma.auditLog.count({ where: { groupId: s.groupId, action: "PAYMENT_ORDER_CREATED" } })).toBe(1);
  });

  it("refuses bad input", async () => {
    const s = await setup();
    const other = await makeUser();
    await createGroup(other, { name: "Other Circle" });

    expect((await monthly(s.m1, s.groupId, 20001)).body.error.code).toBe("AMOUNT_EXCEEDS_DUE");
    expect((await monthly(other, s.groupId)).status).toBe(404); // not a member of that group
    expect((await monthly(s.m1, s.groupId, 50)).status).toBe(400);
    expect((await createOrder(s.m1, { groupId: s.groupId, purpose: "MONTHLY_DEPOSIT", amountPaise: 20000.5 })).status).toBe(400);
    expect((await createOrder(s.m1, { groupId: s.groupId, purpose: "WITHDRAWAL", amountPaise: 20000 })).status).toBe(400);
    expect((await createOrder(s.m1, { groupId: s.groupId, purpose: "LOAN_REPAYMENT", amountPaise: 20000 })).status).toBe(400);
    const noKey = await request(app).post("/api/payments/create-order").set(bearer(s.m1.token)).send({ groupId: s.groupId, purpose: "MONTHLY_DEPOSIT", amountPaise: 20000 });
    expect(noKey.status).toBe(400);
    expect((await request(app).post("/api/payments/create-order").send({})).status).toBe(401);
    expect(await prisma.paymentOrder.count({ where: { groupId: s.groupId } })).toBe(0);
  });

  it("a retry with the same Idempotency-Key returns the same order, even in parallel", async () => {
    const s = await setup();
    const key = nextKey();
    const a = await monthly(s.m1, s.groupId);
    const first = await createOrder(s.m2, { groupId: s.groupId, purpose: "ADDITIONAL_DEPOSIT", amountPaise: 5000 }, key);
    const again = await createOrder(s.m2, { groupId: s.groupId, purpose: "ADDITIONAL_DEPOSIT", amountPaise: 5000 }, key);
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body.order.id).toBe(first.body.order.id);
    expect(a.status).toBe(201);

    const reused = await createOrder(s.m2, { groupId: s.groupId, purpose: "ADDITIONAL_DEPOSIT", amountPaise: 9000 }, key);
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");

    const k2 = nextKey();
    const [x, y] = await Promise.all([
      createOrder(s.m1, { groupId: s.groupId, purpose: "ADDITIONAL_DEPOSIT", amountPaise: 7000 }, k2),
      createOrder(s.m1, { groupId: s.groupId, purpose: "ADDITIONAL_DEPOSIT", amountPaise: 7000 }, k2),
    ]);
    expect([x.status, y.status].sort()).toEqual([200, 201]);
    expect(x.body.order.id).toBe(y.body.order.id);
    expect(await prisma.paymentOrder.count({ where: { userId: s.m1.id, amountPaise: 7000n } })).toBe(1);
  });

  it("GET /config shows the mode and public key only", async () => {
    const s = await setup();
    const res = await request(app).get("/api/payments/config").set(bearer(s.m1.token));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: "sandbox", provider: "simulator", testMode: true });
    expect(JSON.stringify(res.body).toLowerCase()).not.toContain("secret");
  });
});

describe("confirming a payment by webhook", () => {
  it("records the contribution, ledger and notification, and the books stay consistent", async () => {
    const s = await setup();
    const o = await monthly(s.m1, s.groupId);
    const { pay, res } = await payAndNotify(o.body.order.providerOrderId);
    expect(res.status).toBe(200);

    expect((await contributionOf(s.groupId, s.m1.id)).status).toBe("PAID");
    expect(await groupFundBalance(prisma, s.groupId)).toBe(20000n);
    expect(await memberSavingsBalance(prisma, s.groupId, s.m1.id)).toBe(20000n);
    const tx = await prisma.paymentTransaction.findUniqueOrThrow({ where: { providerPaymentId: pay.id } });
    expect(tx).toMatchObject({ status: "SUCCESS", method: "UPI", purpose: "MONTHLY_DEPOSIT", recordedById: null });
    expect(JSON.stringify(tx.rawPayload)).not.toMatch(/email|contact|vpa/i);
    expect((await orderRow(o.body.order.id)).status).toBe("SUCCESS");
    const journal = await prisma.ledgerJournal.findFirstOrThrow({ where: { groupId: s.groupId } });
    expect(journal.idempotencyKey).toBe(`gateway:${pay.id}`);
    expect(await prisma.notification.count({ where: { userId: s.m1.id, type: "PAYMENT_RECEIVED" } })).toBe(1);

    const deposits = await request(app).get(`/api/groups/${s.groupId}/deposits`).set(bearer(s.m1.token));
    expect(deposits.body.items[0]).toMatchObject({ source: "GATEWAY", status: "SUCCESS", amountPaise: 20000 });
    expect((await integrity(s)).body.ok).toBe(true);
  });

  it("duplicate deliveries never credit twice (same event, new event, and in parallel)", async () => {
    const s = await setup();
    const o = await monthly(s.m1, s.groupId);
    const pay = simulatorPay(o.body.order.providerOrderId, "captured");
    const event = paymentEvent("payment.captured", pay.id, o.body.order.providerOrderId);
    const id = nextEvent();

    expect((await webhook(event, { eventId: id })).body.duplicate).toBeUndefined();
    const dup = await webhook(event, { eventId: id });
    expect(dup.status).toBe(200);
    expect(dup.body.duplicate).toBe(true);
    expect((await webhook(event)).status).toBe(200); // a different event id for the same payment
    const [a, b] = await Promise.all([webhook(event), webhook(event)]);
    expect([a.status, b.status]).toEqual([200, 200]);

    expect(await prisma.ledgerJournal.count({ where: { groupId: s.groupId } })).toBe(1);
    expect(await prisma.paymentTransaction.count({ where: { groupId: s.groupId } })).toBe(1);
    expect(await groupFundBalance(prisma, s.groupId)).toBe(20000n);
  });

  it("rejects bad, missing and mismatched signatures and records nothing", async () => {
    const s = await setup();
    const o = await monthly(s.m1, s.groupId);
    const pay = simulatorPay(o.body.order.providerOrderId, "captured");
    const event = paymentEvent("payment.captured", pay.id, o.body.order.providerOrderId);

    const wrong = await webhook(event, { signature: "0".repeat(64) });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe("INVALID_SIGNATURE");
    const none = await request(app).post("/api/payments/webhook").set("Content-Type", "application/json").send(JSON.stringify(event));
    expect(none.status).toBe(400);
    const tampered = await webhook(event, { signature: signSimulatorWebhook("{}") }); // signed a different body
    expect(tampered.status).toBe(400);

    expect(await prisma.webhookEvent.count({ where: { payload: { path: ["paymentId"], equals: pay.id } } })).toBe(0);
    expect(await prisma.paymentTransaction.count({ where: { groupId: s.groupId } })).toBe(0);
    expect((await contributionOf(s.groupId, s.m1.id)).status).toBe("PENDING");
  });

  it("ignores payments that aren't ours", async () => {
    const res = await webhook(paymentEvent("payment.captured", "pay_someone_else_1", "order_not_ours_1"));
    expect(res.status).toBe(200);
  });

  it("a failed attempt leaves the order open, and a retry can still succeed", async () => {
    const s = await setup();
    const o = await monthly(s.m1, s.groupId);
    const providerOrderId = o.body.order.providerOrderId;

    await payAndNotify(providerOrderId, "failed");
    const failed = await prisma.paymentTransaction.findMany({ where: { groupId: s.groupId } });
    expect(failed.map((t) => t.status)).toEqual(["FAILED"]);
    expect((await orderRow(o.body.order.id)).status).toBe("CREATED");
    expect((await contributionOf(s.groupId, s.m1.id)).status).toBe("PENDING");
    expect(await prisma.ledgerJournal.count({ where: { groupId: s.groupId } })).toBe(0);

    await payAndNotify(providerOrderId, "captured");
    expect((await contributionOf(s.groupId, s.m1.id)).status).toBe("PAID");
    expect(await prisma.paymentTransaction.count({ where: { groupId: s.groupId } })).toBe(2);
    expect(await groupFundBalance(prisma, s.groupId)).toBe(20000n);
  });

  it("authorized stays pending until it is captured", async () => {
    const s = await setup();
    const o = await monthly(s.m1, s.groupId);
    const { pay } = await payAndNotify(o.body.order.providerOrderId, "authorized");
    expect((await orderRow(o.body.order.id)).status).toBe("PENDING");
    expect((await contributionOf(s.groupId, s.m1.id)).status).toBe("PENDING");
    expect(await groupFundBalance(prisma, s.groupId)).toBe(0n);

    simulatorUpdate(pay.id, { status: "captured" });
    await webhook(paymentEvent("payment.captured", pay.id, o.body.order.providerOrderId));
    expect((await contributionOf(s.groupId, s.m1.id)).status).toBe("PAID");
    expect((await orderRow(o.body.order.id)).status).toBe("SUCCESS");
    expect(await prisma.paymentTransaction.count({ where: { groupId: s.groupId } })).toBe(1); // upgraded, not duplicated
  });

  it("records nothing when the provider's amount doesn't match the order, and tells the admins", async () => {
    const s = await setup();
    const o = await monthly(s.m1, s.groupId);
    const pay = simulatorPay(o.body.order.providerOrderId, "captured", { amountPaise: 100n });
    const res = await webhook(paymentEvent("payment.captured", pay.id, o.body.order.providerOrderId));
    expect(res.status).toBe(200);
    expect(await prisma.paymentTransaction.count({ where: { groupId: s.groupId } })).toBe(0);
    expect(await prisma.ledgerJournal.count({ where: { groupId: s.groupId } })).toBe(0);
    expect((await orderRow(o.body.order.id)).status).toBe("FAILED");
    await webhook(paymentEvent("payment.captured", pay.id, o.body.order.providerOrderId)); // a retry
    expect(await prisma.notification.count({ where: { userId: s.president.id, type: "PAYMENT_MISMATCH" } })).toBe(1);
  });

  it("additional deposits go straight to savings", async () => {
    const s = await setup();
    const o = await createOrder(s.m1, { groupId: s.groupId, purpose: "ADDITIONAL_DEPOSIT", amountPaise: 150000 });
    await payAndNotify(o.body.order.providerOrderId);
    expect(await memberSavingsBalance(prisma, s.groupId, s.m1.id)).toBe(150000n);
    expect((await prisma.ledgerJournal.findFirstOrThrow({ where: { groupId: s.groupId } })).type).toBe("ADDITIONAL_DEPOSIT");
    expect(await prisma.contribution.count({ where: { groupId: s.groupId, status: { in: ["PAID", "PARTIAL"] } } })).toBe(0); // untouched
  });

  it("if the month was paid in the meantime, the money becomes savings and admins are told", async () => {
    const s = await setup();
    const o = await monthly(s.m1, s.groupId);
    expect((await manual(s.president, s.groupId, { userId: s.m1.id })).status).toBe(201); // paid by hand meanwhile

    const { pay } = await payAndNotify(o.body.order.providerOrderId);
    const tx = await prisma.paymentTransaction.findUniqueOrThrow({ where: { providerPaymentId: pay.id } });
    expect(tx).toMatchObject({ status: "SUCCESS", purpose: "ADDITIONAL_DEPOSIT", contributionId: null });
    expect((await contributionOf(s.groupId, s.m1.id)).paidPaise).toBe(20000n); // not paid twice
    expect(await groupFundBalance(prisma, s.groupId)).toBe(40000n); // but the money WAS received
    expect(await prisma.notification.count({ where: { userId: s.president.id, type: "PAYMENT_REDIRECTED" } })).toBe(1);
    expect((await integrity(s)).body.ok).toBe(true);
  });
});

describe("the browser's report (verify)", () => {
  it("verifies the signature, asks the provider, applies once, and a later webhook adds nothing", async () => {
    const s = await setup();
    const o = await monthly(s.m1, s.groupId);
    const providerOrderId = o.body.order.providerOrderId;
    const pay = simulatorPay(providerOrderId, "captured"); // no webhook yet

    const verify = (sig: string, as: TestUser = s.m1, orderId = providerOrderId) =>
      request(app).post("/api/payments/verify").set(bearer(as.token)).send({
        razorpay_order_id: orderId, razorpay_payment_id: pay.id, razorpay_signature: sig,
      });

    const forged = await verify("f".repeat(64));
    expect(forged.status).toBe(400);
    expect(forged.body.error.code).toBe("INVALID_SIGNATURE");
    expect((await contributionOf(s.groupId, s.m1.id)).status).toBe("PENDING");

    const good = signSimulatorCheckout(providerOrderId, pay.id);
    expect((await verify(good, s.m2)).status).toBe(404); // somebody else's order
    const ok = await verify(good);
    expect(ok.status).toBe(200);
    expect(ok.body.order.status).toBe("SUCCESS");
    expect(ok.body.payments).toHaveLength(1);
    expect((await contributionOf(s.groupId, s.m1.id)).status).toBe("PAID");

    expect((await verify(good)).status).toBe(200); // pressing the button twice
    await webhook(paymentEvent("payment.captured", pay.id, providerOrderId)); // and the webhook arrives later
    expect(await prisma.ledgerJournal.count({ where: { groupId: s.groupId } })).toBe(1);
    expect(await groupFundBalance(prisma, s.groupId)).toBe(20000n);
  });

  it("a correct signature for a payment the provider has never heard of confirms nothing", async () => {
    const s = await setup();
    const o = await monthly(s.m1, s.groupId);
    const providerOrderId = o.body.order.providerOrderId;
    const res = await request(app).post("/api/payments/verify").set(bearer(s.m1.token)).send({
      razorpay_order_id: providerOrderId,
      razorpay_payment_id: "pay_does_not_exist_1",
      razorpay_signature: signSimulatorCheckout(providerOrderId, "pay_does_not_exist_1"),
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("PAYMENT_NOT_FOUND");
    expect((await contributionOf(s.groupId, s.m1.id)).status).toBe("PENDING");
  });

  it("order status is private to its owner", async () => {
    const s = await setup();
    const o = await monthly(s.m1, s.groupId);
    const get = (u: TestUser) => request(app).get(`/api/payments/${o.body.order.id}`).set(bearer(u.token));
    expect((await get(s.m1)).status).toBe(200);
    expect((await get(s.m2)).status).toBe(404);
    expect((await get(s.president)).status).toBe(404);
  });
});

describe("paying a loan online", () => {
  async function loanSetup() {
    const s = await setup();
    await request(app).put(`/api/groups/${s.groupId}`).set(bearer(s.president.token)).send({ interestMethod: "FLAT", interestRateBps: 1200 }).expect(200);
    await manual(s.president, s.groupId, { userId: s.m2.id, purpose: "ADDITIONAL_DEPOSIT", amountPaise: 500000 }).then((r) => expect(r.status).toBe(201));
    const apply = await request(app).post(`/api/groups/${s.groupId}/loans`).set(bearer(s.m1.token))
      .send({ principalPaise: 100000, purpose: "Medical expenses", installmentCount: 4 });
    const loanId = apply.body.loan.id as string;
    await request(app).post(`/api/loans/${loanId}/approve`).set(bearer(s.president.token)).send({}).expect(200);
    await request(app).post(`/api/loans/${loanId}/disburse`).set(bearer(s.president.token)).send({ method: "CASH", note: "Handed over in cash" }).expect(200);
    return { ...s, loanId };
  }
  const loanOrder = (u: TestUser, groupId: string, loanId: string, amountPaise: number) =>
    createOrder(u, { groupId, purpose: "LOAN_REPAYMENT", loanId, amountPaise });

  it("applies an installment: schedule, interest income and cash all move together", async () => {
    const s = await loanSetup();
    expect(await groupFundBalance(prisma, s.groupId)).toBe(400000n);

    expect((await loanOrder(s.m1, s.groupId, s.loanId, 104001)).body.error.code).toBe("AMOUNT_EXCEEDS_OUTSTANDING");
    expect((await loanOrder(s.m2, s.groupId, s.loanId, 26000)).status).toBe(404); // not their loan

    const o = await loanOrder(s.m1, s.groupId, s.loanId, 26000);
    expect(o.status).toBe(201);
    const { pay } = await payAndNotify(o.body.order.providerOrderId);

    const loan = (await request(app).get(`/api/loans/${s.loanId}`).set(bearer(s.m1.token))).body.loan;
    expect(loan.status).toBe("ACTIVE");
    expect(loan.installments[0].status).toBe("PAID");
    expect(loan.outstandingPaise).toBe(78000);
    expect(await groupFundBalance(prisma, s.groupId)).toBe(426000n);
    expect(await creditSum(s.groupId, "INTEREST_INCOME")).toBe(1000n);
    const tx = await prisma.paymentTransaction.findUniqueOrThrow({ where: { providerPaymentId: pay.id } });
    expect(tx).toMatchObject({ purpose: "LOAN_REPAYMENT", loanId: s.loanId, status: "SUCCESS" });
    expect(await prisma.loanRepayment.count({ where: { loanId: s.loanId } })).toBe(1);
    expect((await integrity(s)).body.ok).toBe(true);
  });

  it("money for a loan that was closed in the meantime becomes savings", async () => {
    const s = await loanSetup();
    const o = await loanOrder(s.m1, s.groupId, s.loanId, 26000);
    const closed = await request(app).post(`/api/loans/${s.loanId}/repayments`).set(bearer(s.president.token)).send({
      amountPaise: 104000, method: "CASH", evidenceNote: "Cash received at the meeting", clientRequestId: `lc-${Date.now()}-${++seq}`,
    });
    expect(closed.status).toBe(201);
    expect(closed.body.loan.status).toBe("COMPLETED");

    const { pay } = await payAndNotify(o.body.order.providerOrderId);
    const tx = await prisma.paymentTransaction.findUniqueOrThrow({ where: { providerPaymentId: pay.id } });
    expect(tx).toMatchObject({ purpose: "ADDITIONAL_DEPOSIT", loanId: null });
    expect(await memberSavingsBalance(prisma, s.groupId, s.m1.id)).toBe(26000n);
    expect(await groupFundBalance(prisma, s.groupId)).toBe(400000n + 104000n + 26000n);
    expect((await integrity(s)).body.ok).toBe(true);
  });
});

describe("refunds and disputes", () => {
  async function paidDeposit() {
    const s = await setup();
    const o = await monthly(s.m1, s.groupId);
    const { pay } = await payAndNotify(o.body.order.providerOrderId);
    return { ...s, o, pay, providerOrderId: o.body.order.providerOrderId as string };
  }

  it("a refund is flagged, the ledger is untouched, and the President can reverse the deposit", async () => {
    const s = await paidDeposit();
    simulatorUpdate(s.pay.id, { status: "refunded", amountRefundedPaise: 20000n });
    const refundEvent = {
      event: "refund.processed",
      payload: { refund: { entity: { id: "rfnd_1", payment_id: s.pay.id } }, payment: { entity: { id: s.pay.id, order_id: s.providerOrderId } } },
    };
    expect((await webhook(refundEvent)).status).toBe(200);

    expect((await prisma.paymentTransaction.findUniqueOrThrow({ where: { providerPaymentId: s.pay.id } })).status).toBe("REFUNDED");
    expect((await orderRow(s.o.body.order.id)).status).toBe("REFUNDED");
    expect(await prisma.ledgerJournal.count({ where: { groupId: s.groupId } })).toBe(1); // nothing rewritten
    expect(await prisma.notification.count({ where: { userId: s.president.id, type: "PAYMENT_REFUNDED" } })).toBe(1);

    const journal = await prisma.ledgerJournal.findFirstOrThrow({ where: { groupId: s.groupId, type: "MONTHLY_DEPOSIT" } });
    const reversal = await request(app)
      .post(`/api/groups/${s.groupId}/transactions/${journal.id}/reverse`)
      .set(bearer(s.president.token))
      .send({ reason: "Payment was refunded by the provider" });
    expect(reversal.status).toBe(201);
    expect(await groupFundBalance(prisma, s.groupId)).toBe(0n);
    expect((await contributionOf(s.groupId, s.m1.id)).status).toBe("PENDING");
    expect((await integrity(s)).body.ok).toBe(true);
  });

  it("a dispute marks the payment, and winning it restores it", async () => {
    const s = await paidDeposit();
    const dispute = (type: string) => ({
      event: type,
      payload: { dispute: { entity: { id: "disp_1", payment_id: s.pay.id } }, payment: { entity: { id: s.pay.id, order_id: s.providerOrderId } } },
    });
    const status = async () => (await prisma.paymentTransaction.findUniqueOrThrow({ where: { providerPaymentId: s.pay.id } })).status;

    await webhook(dispute("payment.dispute.created"));
    expect(await status()).toBe("DISPUTED");
    expect(await prisma.notification.count({ where: { userId: s.president.id, type: "PAYMENT_DISPUTED" } })).toBe(1);

    await webhook(dispute("payment.dispute.won"));
    expect(await status()).toBe("SUCCESS");

    await webhook(dispute("payment.dispute.created"));
    await webhook(dispute("payment.dispute.lost"));
    expect(await status()).toBe("DISPUTED");
    expect(await prisma.notification.count({ where: { userId: s.president.id, type: "PAYMENT_DISPUTE_LOST" } })).toBe(1);
    expect(await prisma.ledgerJournal.count({ where: { groupId: s.groupId } })).toBe(1); // the ledger is never rewritten silently
  });

  it("a partial refund is noticed once", async () => {
    const s = await paidDeposit();
    simulatorUpdate(s.pay.id, { amountRefundedPaise: 5000n }); // still "captured"
    await webhook({ event: "refund.processed", payload: { refund: { entity: { id: "rfnd_2", payment_id: s.pay.id } } } });
    await webhook({ event: "refund.processed", payload: { refund: { entity: { id: "rfnd_2", payment_id: s.pay.id } } } });
    expect((await prisma.paymentTransaction.findUniqueOrThrow({ where: { providerPaymentId: s.pay.id } })).status).toBe("SUCCESS");
    expect(await prisma.notification.count({ where: { userId: s.president.id, type: "PAYMENT_PARTIAL_REFUND" } })).toBe(1);
  });
});

describe("reconciliation", () => {
  it("applies a payment whose webhook never arrived, and runs safely twice", async () => {
    const s = await setup();
    const o = await monthly(s.m1, s.groupId);
    simulatorPay(o.body.order.providerOrderId, "captured"); // no webhook, no verify
    expect((await contributionOf(s.groupId, s.m1.id)).status).toBe("PENDING");

    const first = await reconcilePayments({ groupId: s.groupId, olderThanMinutes: 0 });
    expect(first.applied).toBe(1);
    expect((await contributionOf(s.groupId, s.m1.id)).status).toBe("PAID");
    expect(await groupFundBalance(prisma, s.groupId)).toBe(20000n);

    const second = await reconcilePayments({ groupId: s.groupId, olderThanMinutes: 0 });
    expect(second.checked).toBe(0); // the order is SUCCESS now
    expect(await prisma.ledgerJournal.count({ where: { groupId: s.groupId } })).toBe(1);
  });

  it("marks orders nobody paid for as abandoned, and leaves recent ones alone", async () => {
    const s = await setup();
    const old = await monthly(s.m1, s.groupId);
    const fresh = await createOrder(s.m2, { groupId: s.groupId, purpose: "ADDITIONAL_DEPOSIT", amountPaise: 5000 });
    await prisma.paymentOrder.update({ where: { id: old.body.order.id }, data: { createdAt: new Date(Date.now() - 3 * 86_400_000) } });

    const r = await reconcilePayments({ groupId: s.groupId, olderThanMinutes: 0 });
    expect(r.abandoned).toBe(1);
    expect((await orderRow(old.body.order.id)).status).toBe("FAILED");
    expect((await orderRow(fresh.body.order.id)).status).toBe("CREATED");
  });
});
