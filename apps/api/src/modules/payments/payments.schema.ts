import { z } from "zod";

// Money is integer PAISE (₹200 = 20000).
export const createOrderSchema = z
  .object({
    groupId: z.string().uuid(),
    purpose: z.enum(["MONTHLY_DEPOSIT", "ADDITIONAL_DEPOSIT", "LOAN_REPAYMENT"]),
    amountPaise: z
      .number()
      .int("Amount must be a whole number of paise")
      .min(100, "Minimum payment is ₹1")
      .max(100_000_000, "Maximum payment is ₹10,00,000"),
    loanId: z.string().uuid().optional(),
  })
  .refine((v) => (v.purpose === "LOAN_REPAYMENT") === (v.loanId !== undefined), {
    message: "loanId is required for loan repayments, and not allowed otherwise",
    path: ["loanId"],
  });

// Sent as a header: Idempotency-Key. The frontend makes one per "Pay" click.
export const idempotencyKeySchema = z
  .string()
  .trim()
  .min(8)
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/);

// The three values Razorpay's checkout hands back to the browser after payment.
export const verifySchema = z.object({
  razorpay_order_id: z.string().trim().min(5).max(100),
  razorpay_payment_id: z.string().trim().min(5).max(100),
  razorpay_signature: z.string().trim().min(10).max(200),
});

export const simulatorPaySchema = z.object({
  orderId: z.string().trim().min(5).max(100), // the PROVIDER order id
  outcome: z.enum(["success", "fail", "authorize"]).default("success"),
  deliverWebhook: z.boolean().default(true),
});

export const simulatorRefundSchema = z.object({
  paymentId: z.string().trim().min(5).max(100),
});

export type CreateOrderInput = z.infer<typeof createOrderSchema>;
export type VerifyInput = z.infer<typeof verifySchema>;
export type SimulatorPayInput = z.infer<typeof simulatorPaySchema>;
export type SimulatorRefundInput = z.infer<typeof simulatorRefundSchema>;
