import { env } from "../../config/env";
import { hmacSha256Hex, safeEqual } from "../hmac";
import { ProviderError, type PaymentProvider, type RemotePayment } from "./types";

const BASE = "https://api.razorpay.com/v1";

type RzpPayment = {
  id: string;
  order_id?: string | null;
  amount: number;
  currency: string;
  status: string;
  method?: string | null;
  amount_refunded?: number;
  error_code?: string | null;
  error_description?: string | null;
  created_at: number; // unix seconds
};

const toRemote = (p: RzpPayment): RemotePayment => ({
  id: p.id,
  orderId: p.order_id ?? null,
  amountPaise: BigInt(p.amount),
  currency: p.currency,
  status: p.status,
  method: p.method ?? null,
  amountRefundedPaise: BigInt(p.amount_refunded ?? 0),
  errorCode: p.error_code ?? null,
  errorDescription: p.error_description ?? null,
  createdAt: new Date(p.created_at * 1000),
});

export function razorpayProvider(): PaymentProvider {
  // env.ts guarantees these exist when PAYMENT_PROVIDER=razorpay.
  const keyId = env.RAZORPAY_KEY_ID as string;
  const keySecret = env.RAZORPAY_KEY_SECRET as string;
  const webhookSecret = env.RAZORPAY_WEBHOOK_SECRET as string;
  const auth = "Basic " + Buffer.from(`${keyId}:${keySecret}`).toString("base64");

  async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${BASE}${path}`, {
        method,
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new ProviderError("Could not reach Razorpay.", "UNAVAILABLE");
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      // not JSON
    }
    if (res.ok) return json as T;

    const description =
      (json as { error?: { description?: string } } | null)?.error?.description ?? `HTTP ${res.status}`;
    if (res.status === 404 || (res.status === 400 && /does not exist|not found/i.test(description))) {
      throw new ProviderError(description, "NOT_FOUND");
    }
    if (res.status >= 500 || res.status === 429) throw new ProviderError(description, "UNAVAILABLE");
    throw new ProviderError(description, "REJECTED");
  }

  return {
    name: "razorpay",
    keyId,

    async createOrder({ receipt, amountPaise, notes }) {
      const order = await call<{ id: string }>("POST", "/orders", {
        amount: Number(amountPaise),
        currency: "INR",
        receipt, // max 40 characters
        notes,
      });
      return { providerOrderId: order.id };
    },

    async fetchPayment(paymentId) {
      return toRemote(await call<RzpPayment>("GET", `/payments/${encodeURIComponent(paymentId)}`));
    },

    async fetchOrderPayments(providerOrderId) {
      const res = await call<{ items: RzpPayment[] }>("GET", `/orders/${encodeURIComponent(providerOrderId)}/payments`);
      return res.items.map(toRemote);
    },

    // Razorpay signs "<order_id>|<payment_id>" with your KEY SECRET after checkout.
    verifyCheckoutSignature(providerOrderId, paymentId, signature) {
      return safeEqual(hmacSha256Hex(keySecret, `${providerOrderId}|${paymentId}`), signature.toLowerCase());
    },

    // Razorpay signs the exact raw request body with the WEBHOOK SECRET (a different secret).
    verifyWebhookSignature(rawBody, signature) {
      return safeEqual(hmacSha256Hex(webhookSecret, rawBody), signature.toLowerCase());
    },
  };
}
