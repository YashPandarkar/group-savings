import { randomUUID } from "node:crypto";
import { Router } from "express";
import { env } from "../../config/env";
import { prisma } from "../../config/prisma";
import { AppError } from "../../lib/errors";
import { requireAuth } from "../../middleware/requireAuth";
import { validateBody } from "../../middleware/validate";
import { simulatorPay, simulatorUpdate, signSimulatorCheckout, signSimulatorWebhook } from "../../lib/providers/simulator";
import { simulatorPaySchema, simulatorRefundSchema, type SimulatorPayInput, type SimulatorRefundInput } from "./payments.schema";

const router = Router();

// Delivers a SIGNED webhook to our own public webhook route, exactly like Razorpay would.
async function deliver(type: string, entity: Record<string, string | null>, extra: Record<string, unknown> = {}) {
  const body = JSON.stringify({ event: type, payload: { payment: { entity }, ...extra } });
  const res = await fetch(`http://127.0.0.1:${env.PORT}/api/payments/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-razorpay-signature": signSimulatorWebhook(body),
      "x-razorpay-event-id": `evt_sim_${randomUUID()}`,
    },
    body,
  });
  return res.status;
}

router.post("/pay", requireAuth, validateBody(simulatorPaySchema), async (req, res) => {
  const { orderId, outcome, deliverWebhook } = req.body as SimulatorPayInput;
  const order = await prisma.paymentOrder.findFirst({ where: { providerOrderId: orderId, userId: req.user!.id } });
  if (!order) throw new AppError(404, "ORDER_NOT_FOUND", "Order not found.");

  const status = outcome === "success" ? "captured" : outcome === "fail" ? "failed" : "authorized";
  const payment = simulatorPay(orderId, status);
  const type = outcome === "success" ? "payment.captured" : outcome === "fail" ? "payment.failed" : "payment.authorized";
  const webhookStatus = deliverWebhook ? await deliver(type, { id: payment.id, order_id: orderId }) : null;

  res.json({
    payment: { id: payment.id, status: payment.status },
    // This is what Razorpay's checkout would hand to the browser. Send it to POST /api/payments/verify.
    checkout: {
      razorpay_order_id: orderId,
      razorpay_payment_id: payment.id,
      razorpay_signature: signSimulatorCheckout(orderId, payment.id),
    },
    webhookStatus,
  });
});

router.post("/refund", requireAuth, validateBody(simulatorRefundSchema), async (req, res) => {
  const { paymentId } = req.body as SimulatorRefundInput;
  const tx = await prisma.paymentTransaction.findFirst({ where: { providerPaymentId: paymentId, userId: req.user!.id } });
  if (!tx) throw new AppError(404, "PAYMENT_NOT_FOUND", "Payment not found.");
  simulatorUpdate(paymentId, { status: "refunded", amountRefundedPaise: tx.amountPaise });
  const webhookStatus = await deliver("refund.processed", { id: paymentId }, { refund: { entity: { id: `rfnd_sim_${randomUUID().slice(0, 8)}`, payment_id: paymentId } } });
  res.json({ refunded: true, webhookStatus });
});

export default router;
