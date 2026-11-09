import type { Request, Response } from "express";
import { prisma } from "../../config/prisma";
import { AppError } from "../../lib/errors";
import { isUniqueViolation } from "../../lib/dbErrors";
import { provider } from "../../lib/paymentProvider";
import { sha256 } from "../../lib/tokens";
import { syncPayment, type DisputeHint } from "./payments.sync";

// Events that mean "something happened to a payment". For all of them we do the same thing:
// ask the provider's API for the payment's current state and make our records agree.
const PAYMENT_EVENTS = new Set([
  "payment.authorized",
  "payment.captured",
  "payment.failed",
  "order.paid",
  "refund.created",
  "refund.processed",
  "refund.failed",
  "payment.dispute.created",
  "payment.dispute.under_review",
  "payment.dispute.action_required",
  "payment.dispute.won",
  "payment.dispute.lost",
  "payment.dispute.closed",
]);

const DISPUTE_HINTS: Record<string, DisputeHint> = {
  "payment.dispute.created": "OPENED",
  "payment.dispute.under_review": "OPENED",
  "payment.dispute.action_required": "OPENED",
  "payment.dispute.won": "WON",
  "payment.dispute.lost": "LOST",
};

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (typeof v === "object" && v !== null ? (v as Obj) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 && v.length <= 100 ? v : null);

function extractIds(event: unknown) {
  const payload = obj(obj(event).payload);
  const payment = obj(obj(payload.payment).entity);
  const refund = obj(obj(payload.refund).entity);
  const dispute = obj(obj(payload.dispute).entity);
  return {
    paymentId: str(payment.id) ?? str(refund.payment_id) ?? str(dispute.payment_id),
    orderId: str(payment.order_id) ?? str(obj(obj(payload.order).entity).id),
  };
}

// MOUNTED BEFORE express.json() in app.ts. The signature is computed over the exact bytes
// the provider sent, and re-serialising parsed JSON would change them.
export async function webhookHandler(req: Request, res: Response) {
  const raw: unknown = req.body;
  if (!Buffer.isBuffer(raw) || raw.length === 0) {
    throw new AppError(400, "INVALID_WEBHOOK", "Expected a JSON body.");
  }

  // 1. Authenticity. Nothing else happens until this passes.
  const signature = req.get("x-razorpay-signature") ?? "";
  if (!provider.verifyWebhookSignature(raw, signature)) {
    console.warn("Webhook rejected: signature verification failed.");
    throw new AppError(400, "INVALID_SIGNATURE", "Signature verification failed.");
  }

  let event: unknown;
  try {
    event = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new AppError(400, "INVALID_WEBHOOK", "Body is not valid JSON.");
  }

  const eventType = (str(obj(event).event) ?? "unknown").slice(0, 100);
  const eventId = req.get("x-razorpay-event-id")?.slice(0, 100) || `sha256:${sha256(raw.toString("utf8"))}`;
  const ids = extractIds(event);

  // 2. Duplicate delivery? The unique key makes a second attempt harmless.
  let recordId: string;
  try {
    // Stored minimised: no emails, phone numbers or UPI IDs.
    const created = await prisma.webhookEvent.create({
      data: { provider: provider.name, eventId, eventType, payload: { event: eventType, paymentId: ids.paymentId, orderId: ids.orderId } },
    });
    recordId = created.id;
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    const prior = await prisma.webhookEvent.findUnique({
      where: { provider_eventId: { provider: provider.name, eventId } },
    });
    if (!prior) throw e;
    if (prior.processedAt) return res.status(200).json({ received: true, duplicate: true });
    recordId = prior.id; // an earlier attempt crashed half-way: process it again (the work is idempotent)
  }

  // 3. Do the work. If this throws, we answer 500, the event stays unprocessed, and the provider retries.
  if (PAYMENT_EVENTS.has(eventType) && ids.paymentId) {
    await syncPayment(ids.paymentId, DISPUTE_HINTS[eventType]);
  }
  await prisma.webhookEvent.update({ where: { id: recordId }, data: { processedAt: new Date() } });
  res.status(200).json({ received: true });
}
