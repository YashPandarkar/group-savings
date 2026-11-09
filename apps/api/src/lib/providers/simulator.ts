import { randomBytes } from "node:crypto";
import { hmacSha256Hex, safeEqual } from "../hmac";
import {
  ProviderError,
  type PaymentProvider,
  type ProviderOrderInput,
  type RemotePayment,
} from "./types";

// A fake gateway for local work and tests. It never moves money.
// It lives in memory, so restarting the API forgets its orders and payments.
const CHECKOUT_SECRET = "simulator-checkout-secret";
const WEBHOOK_SECRET = "simulator-webhook-secret";

const orders = new Map<string, { amountPaise: bigint; notes: Record<string, string> }>();
const payments = new Map<string, RemotePayment>();
const rand = () => randomBytes(7).toString("hex");

export const signSimulatorCheckout = (providerOrderId: string, paymentId: string) =>
  hmacSha256Hex(CHECKOUT_SECRET, `${providerOrderId}|${paymentId}`);
export const signSimulatorWebhook = (body: string | Buffer) => hmacSha256Hex(WEBHOOK_SECRET, body);

export const simulatorProvider: PaymentProvider = {
  name: "simulator",
  keyId: "simulator",

  async createOrder(input: ProviderOrderInput) {
    const providerOrderId = `order_sim_${rand()}`;
    orders.set(providerOrderId, { amountPaise: input.amountPaise, notes: input.notes });
    return { providerOrderId };
  },

  async fetchPayment(paymentId) {
    const p = payments.get(paymentId);
    if (!p) throw new ProviderError("The id provided does not exist", "NOT_FOUND");
    return { ...p };
  },

  async fetchOrderPayments(providerOrderId) {
    return [...payments.values()].filter((p) => p.orderId === providerOrderId).map((p) => ({ ...p }));
  },

  verifyCheckoutSignature: (providerOrderId, paymentId, signature) =>
    safeEqual(signSimulatorCheckout(providerOrderId, paymentId), signature),

  verifyWebhookSignature: (rawBody, signature) => safeEqual(signSimulatorWebhook(rawBody), signature),
};

// "The customer pays (or fails to pay) this order."
export function simulatorPay(
  providerOrderId: string,
  status: "captured" | "failed" | "authorized",
  opts: { method?: string; amountPaise?: bigint } = {}
): RemotePayment {
  const order = orders.get(providerOrderId);
  if (!order) throw new Error(`Simulator doesn't know order ${providerOrderId}`);
  const payment: RemotePayment = {
    id: `pay_sim_${rand()}`,
    orderId: providerOrderId,
    amountPaise: opts.amountPaise ?? order.amountPaise,
    currency: "INR",
    status,
    method: opts.method ?? "upi",
    amountRefundedPaise: 0n,
    errorCode: status === "failed" ? "BAD_REQUEST_ERROR" : null,
    errorDescription: status === "failed" ? "Payment failed (simulated)" : null,
    createdAt: new Date(),
  };
  payments.set(payment.id, payment);
  return { ...payment };
}

// Used to simulate later changes: a capture, a refund...
export function simulatorUpdate(paymentId: string, patch: Partial<RemotePayment>): void {
  const p = payments.get(paymentId);
  if (!p) throw new Error(`Simulator doesn't know payment ${paymentId}`);
  payments.set(paymentId, { ...p, ...patch });
}

export function simulatorReset(): void {
  orders.clear();
  payments.clear();
}
