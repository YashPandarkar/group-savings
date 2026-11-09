import { Router, type Request } from "express";
import { AppError } from "../../lib/errors";
import { requireAuth } from "../../middleware/requireAuth";
import { paymentLimiter } from "../../middleware/rateLimit";
import { validateBody } from "../../middleware/validate";
import * as payments from "./payments.service";
import {
  createOrderSchema,
  idempotencyKeySchema,
  verifySchema,
  type CreateOrderInput,
  type VerifyInput,
} from "./payments.schema";

const router = Router();
const meta = (req: Request) => ({ ip: req.ip, userAgent: req.get("user-agent") });

// Public values the frontend needs (mode, public key). Never secrets.
router.get("/config", requireAuth, (_req, res) => {
  res.json(payments.publicConfig());
});

router.post("/create-order", requireAuth, paymentLimiter, validateBody(createOrderSchema), async (req, res) => {
  const key = idempotencyKeySchema.safeParse(req.get("idempotency-key"));
  if (!key.success) {
    throw new AppError(400, "VALIDATION_ERROR", "An Idempotency-Key header is required (8 to 100 letters, numbers, - or _).");
  }
  const out = await payments.createOrder(req.user!, req.body as CreateOrderInput, key.data, meta(req));
  res.status(out.replayed ? 200 : 201).json(out);
});

router.post("/verify", requireAuth, paymentLimiter, validateBody(verifySchema), async (req, res) => {
  res.json(await payments.verifyCheckout(req.user!, req.body as VerifyInput, meta(req)));
});

// Poll this after checkout to see whether the payment has been confirmed. Owner only.
router.get("/:orderId", requireAuth, async (req, res) => {
  res.json(await payments.getOrder(req.user!.id, String(req.params.orderId)));
});

export default router;
