import { randomUUID } from "node:crypto";
import type { PaymentOrder } from "@prisma/client";
import { env } from "../../config/env";
import { prisma } from "../../config/prisma";
import { AppError } from "../../lib/errors";
import { audit } from "../../lib/audit";
import { can } from "../../lib/permissions";
import { isUniqueViolation } from "../../lib/dbErrors";
import { formatRupees, paiseToNumber } from "../../lib/money";
import { periodOf } from "../../lib/period";
import { allocateRepayment, isDue, outstanding } from "../../lib/loanRules";
import { provider, ProviderError } from "../../lib/paymentProvider";
import type { RemotePayment } from "../../lib/providers/types";
import type { RequestMeta } from "../auth/auth.service";
import { ensureContributions } from "../contributions/contributions.service";
import { LIVE_STATUSES, syncGroupLoans } from "../loans/loans.service";
import { syncRemote } from "./payments.sync";
import type { CreateOrderInput, VerifyInput } from "./payments.schema";

type Payer = { id: string; name: string; email: string };

const serializeOrder = (o: PaymentOrder) => ({
  id: o.id,
  providerOrderId: o.providerOrderId,
  groupId: o.groupId,
  purpose: o.purpose,
  amountPaise: paiseToNumber(o.amountPaise),
  currency: o.currency,
  status: o.status,
  contributionId: o.contributionId,
  loanId: o.loanId,
  createdAt: o.createdAt,
});

// Everything the browser's checkout widget needs. Only the PUBLIC key id; never a secret.
const buildCheckout = (o: PaymentOrder, groupName: string, payer: Payer) => ({
  provider: provider.name,
  key: provider.keyId,
  orderId: o.providerOrderId,
  amount: paiseToNumber(o.amountPaise),
  currency: o.currency,
  name: groupName,
  description: o.purpose === "LOAN_REPAYMENT" ? "Loan repayment" : "Group savings deposit",
  prefill: { name: payer.name, email: payer.email },
});

function providerFailure(e: unknown): never {
  console.error("Payment provider error:", e instanceof Error ? e.message : e); // never log secrets
  if (e instanceof ProviderError && e.kind === "REJECTED") {
    throw new AppError(502, "PROVIDER_REJECTED", "The payment provider rejected this request.");
  }
  throw new AppError(503, "PROVIDER_UNAVAILABLE", "The payment provider is unavailable right now. Please try again in a minute.");
}

export function publicConfig() {
  return {
    mode: env.PAYMENT_MODE,
    provider: provider.name,
    keyId: provider.keyId,
    testMode: env.PAYMENT_MODE !== "live",
  };
}

// ───────────── create an order ─────────────

export async function createOrder(user: Payer, input: CreateOrderInput, key: string, meta: RequestMeta) {
  const membership = await prisma.groupMember.findFirst({
    where: { groupId: input.groupId, userId: user.id, status: "ACTIVE" },
    select: {
      role: true,
      group: { select: { name: true, allowPartialRepayment: true, allowEarlyRepayment: true } },
    },
  });
  if (!membership) throw new AppError(404, "NOT_FOUND", "Group not found."); // also hides other groups' IDs

  const needed = input.purpose === "LOAN_REPAYMENT" ? "loan:repay" : "deposit:create";
  if (!can(membership.role, needed)) throw new AppError(403, "FORBIDDEN", "You don't have permission to do this.");

  const amount = BigInt(input.amountPaise);
  const replay = (o: PaymentOrder) => {
    if (o.groupId !== input.groupId || o.purpose !== input.purpose || o.amountPaise !== amount || o.loanId !== (input.loanId ?? null)) {
      throw new AppError(409, "IDEMPOTENCY_KEY_REUSED", "That Idempotency-Key was already used for a different payment.");
    }
    return { replayed: true, order: serializeOrder(o), checkout: buildCheckout(o, membership.group.name, user) };
  };

  // A retry with the same key gets the same order back.
  const existing = await prisma.paymentOrder.findUnique({
    where: { userId_idempotencyKey: { userId: user.id, idempotencyKey: key } },
  });
  if (existing) return replay(existing);

  // ── Validate against the member's real obligations. The client's word is never enough. ──
  let contributionId: string | null = null;
  const now = new Date();

  if (input.purpose === "MONTHLY_DEPOSIT") {
    const cur = periodOf(now);
    await ensureContributions(prisma, input.groupId, cur.year, cur.month);
    const c = await prisma.contribution.findFirst({
      where: { groupId: input.groupId, userId: user.id, status: { in: ["PENDING", "PARTIAL"] } },
      orderBy: [{ periodYear: "asc" }, { periodMonth: "asc" }], // oldest unpaid month first
    });
    if (!c) {
      throw new AppError(409, "NOTHING_DUE", "You have no unpaid monthly contribution. Choose an additional deposit instead.");
    }
    const remaining = c.expectedPaise - c.paidPaise;
    if (amount > remaining) {
      throw new AppError(409, "AMOUNT_EXCEEDS_DUE", `Only ${formatRupees(remaining)} is still due. Pay the extra as an additional deposit.`);
    }
    contributionId = c.id;
  }

  if (input.purpose === "LOAN_REPAYMENT") {
    await syncGroupLoans(input.groupId);
    const loan = await prisma.loan.findFirst({
      where: { id: input.loanId, groupId: input.groupId, userId: user.id }, // only YOUR OWN loan
      include: { installments: { orderBy: { number: "asc" } } },
    });
    if (!loan) throw new AppError(404, "LOAN_NOT_FOUND", "Loan not found.");
    if (!LIVE_STATUSES.includes(loan.status)) {
      throw new AppError(409, "LOAN_NOT_ACTIVE", "This loan has no repayments due.");
    }
    const { allocations, leftover } = allocateRepayment(loan.installments, amount);
    if (leftover > 0n) {
      const total = loan.installments.reduce((s, i) => s + outstanding(i).total, 0n);
      throw new AppError(409, "AMOUNT_EXCEEDS_OUTSTANDING", `Only ${formatRupees(total)} is outstanding on this loan.`);
    }
    if (!membership.group.allowEarlyRepayment) {
      for (const a of allocations) {
        const inst = loan.installments.find((i) => i.id === a.installmentId)!;
        if (!isDue(inst, now)) {
          throw new AppError(409, "EARLY_REPAYMENT_NOT_ALLOWED", `Installment ${a.number} isn't due yet, and this group doesn't allow early repayment.`);
        }
      }
    }
    if (!membership.group.allowPartialRepayment && allocations.some((a) => !a.fullyPaid)) {
      throw new AppError(409, "PARTIAL_PAYMENT_NOT_ALLOWED", "This group doesn't allow partial payments: pay each installment in full.");
    }
  }

  // Stops someone from spamming the payment provider with unpaid orders.
  const recent = await prisma.paymentOrder.count({
    where: { userId: user.id, status: "CREATED", createdAt: { gt: new Date(now.getTime() - 60 * 60 * 1000) } },
  });
  if (recent >= 10) {
    throw new AppError(429, "TOO_MANY_PENDING_ORDERS", "You have several unpaid orders. Complete or wait before starting another.");
  }

  // ── Create the order at the provider, then record it. ──
  const id = randomUUID();
  let providerOrderId: string;
  try {
    ({ providerOrderId } = await provider.createOrder({
      receipt: `ord_${id.replace(/-/g, "").slice(0, 30)}`, // Razorpay allows at most 40 characters
      amountPaise: amount,
      notes: { orderId: id, groupId: input.groupId, purpose: input.purpose },
    }));
  } catch (e) {
    providerFailure(e);
  }

  let order: PaymentOrder;
  try {
    order = await prisma.paymentOrder.create({
      data: {
        id,
        groupId: input.groupId,
        userId: user.id,
        purpose: input.purpose,
        amountPaise: amount,
        providerOrderId,
        provider: provider.name,
        idempotencyKey: key,
        contributionId,
        loanId: input.loanId ?? null,
      },
    });
  } catch (e) {
    if (isUniqueViolation(e)) {
      // A parallel request with the same key won the race. Return ITS order.
      // (Our own provider order stays unpaid and harmless.)
      const winner = await prisma.paymentOrder.findUnique({
        where: { userId_idempotencyKey: { userId: user.id, idempotencyKey: key } },
      });
      if (winner) return replay(winner);
    }
    throw e;
  }

  await audit({
    actorId: user.id,
    groupId: input.groupId,
    action: "PAYMENT_ORDER_CREATED",
    entityType: "PaymentOrder",
    entityId: order.id,
    after: { purpose: input.purpose, amountPaise: input.amountPaise, provider: provider.name },
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  return { replayed: false, order: serializeOrder(order), checkout: buildCheckout(order, membership.group.name, user) };
}

// ───────────── reading an order ─────────────

export async function getOrder(userId: string, orderId: string) {
  const order = await prisma.paymentOrder.findFirst({
    where: { id: orderId, userId }, // owner only
    include: { transactions: { orderBy: { createdAt: "asc" } } },
  });
  if (!order) throw new AppError(404, "ORDER_NOT_FOUND", "Order not found.");
  return {
    order: serializeOrder(order),
    payments: order.transactions.map((t) => ({
      id: t.id,
      status: t.status,
      purpose: t.purpose,
      amountPaise: paiseToNumber(t.amountPaise),
      method: t.method,
      paidAt: t.paidAt,
      createdAt: t.createdAt,
    })),
  };
}

// ───────────── after checkout: the browser reports back ─────────────

export async function verifyCheckout(user: Payer, input: VerifyInput, meta: RequestMeta) {
  const order = await prisma.paymentOrder.findFirst({
    where: { providerOrderId: input.razorpay_order_id, userId: user.id },
  });
  if (!order) throw new AppError(404, "ORDER_NOT_FOUND", "Order not found.");

  // 1. The signature proves the provider handed these three values to the browser.
  if (!provider.verifyCheckoutSignature(order.providerOrderId, input.razorpay_payment_id, input.razorpay_signature)) {
    await audit({
      actorId: user.id,
      groupId: order.groupId,
      action: "PAYMENT_SIGNATURE_INVALID",
      entityType: "PaymentOrder",
      entityId: order.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    throw new AppError(400, "INVALID_SIGNATURE", "Payment verification failed.");
  }

  // 2. But we still ask the provider's API what really happened. That answer is the truth.
  let remote: RemotePayment;
  try {
    remote = await provider.fetchPayment(input.razorpay_payment_id);
  } catch (e) {
    if (e instanceof ProviderError && e.kind === "NOT_FOUND") {
      throw new AppError(400, "PAYMENT_NOT_FOUND", "The payment provider has no such payment.");
    }
    providerFailure(e);
  }
  if (remote.orderId !== order.providerOrderId) {
    throw new AppError(400, "PAYMENT_ORDER_MISMATCH", "That payment belongs to a different order.");
  }

  // 3. Apply it (idempotent: the webhook may already have done so, or may do so soon).
  await syncRemote(remote);
  return getOrder(user.id, order.id);
}
