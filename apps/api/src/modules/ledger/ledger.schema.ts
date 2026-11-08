import { z } from "zod";

const TYPES = [
  "OPENING_CONTRIBUTION", "MONTHLY_DEPOSIT", "ADDITIONAL_DEPOSIT", "LOAN_DISBURSEMENT",
  "LOAN_REPAYMENT", "LOAN_INTEREST_PAYMENT", "GROUP_WITHDRAWAL", "REFUND", "ADJUSTMENT", "REVERSAL",
] as const;

// Dates are calendar days in India (IST).
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .refine((v) => !Number.isNaN(Date.parse(v)), "Invalid date");

export const txListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    q: z.string().trim().max(100).optional(), // member name OR start of a transaction ID
    type: z.enum(TYPES).optional(),
    from: day.optional(),
    to: day.optional(),
    status: z.enum(["POSTED", "REVERSED", "REVERSAL"]).optional(),
    paymentStatus: z.enum(["CREATED", "PENDING", "SUCCESS", "FAILED", "REFUNDED", "DISPUTED"]).optional(),
    memberUserId: z.string().uuid().optional(), // administrators only
    sort: z.enum(["date_desc", "date_asc"]).default("date_desc"),
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, { message: "'from' must not be after 'to'", path: ["to"] });

export const reverseSchema = z.object({
  reason: z.string().trim().min(10, "Explain the reason (at least 10 characters)").max(500),
});

export const yearQuerySchema = z.object({
  year: z.coerce.number().int().min(2020).max(2100).optional(),
});

export type TxListQuery = z.infer<typeof txListQuerySchema>;
export type ReverseInput = z.infer<typeof reverseSchema>;
export type YearQuery = z.infer<typeof yearQuerySchema>;
