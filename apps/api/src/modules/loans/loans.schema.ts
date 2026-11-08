import { z } from "zod";

// Money is integer PAISE (₹100 = 10000).
const reference = z
  .string()
  .trim()
  .min(6)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "Use letters, numbers, - and _ only");
const frequency = z.enum(["WEEKLY", "MONTHLY"]);
const evidenceNote = z.string().trim().min(5, "Describe the evidence (e.g. 'UTR checked in bank app')").max(500);
const maxCount = (f?: string) => (f === "WEEKLY" ? 156 : 60);

export const applyLoanSchema = z
  .object({
    principalPaise: z
      .number()
      .int("Amount must be a whole number of paise")
      .min(10000, "Minimum loan is ₹100")
      .max(1_000_000_000, "Amount is too large"),
    purpose: z.string().trim().min(5, "Describe the purpose").max(300),
    installmentCount: z.number().int().min(1).max(156).optional(),
    repaymentFrequency: frequency.optional(),
    // Interest fields are NOT accepted: terms always come from the group's policy.
  })
  .refine((v) => v.installmentCount === undefined || v.installmentCount <= maxCount(v.repaymentFrequency), {
    message: "Too many installments for this frequency (max 60 monthly, 156 weekly)",
    path: ["installmentCount"],
  });

export const noteSchema = z.object({ note: z.string().trim().max(500).optional() }).default({});

export const rejectSchema = z.object({
  reason: z.string().trim().min(10, "Explain the reason (at least 10 characters)").max(500),
});

export const disburseSchema = z
  .object({
    method: z.enum(["BANK_TRANSFER", "UPI", "CASH", "OTHER"]),
    reference: reference.optional(), // bank / UPI reference of the REAL transfer
    note: evidenceNote,
  })
  .refine((v) => v.method === "CASH" || !!v.reference, {
    message: "A transfer reference (UTR / transaction ID) is required for non-cash disbursements",
    path: ["reference"],
  });

export const repaymentSchema = z
  .object({
    amountPaise: z
      .number()
      .int("Amount must be a whole number of paise")
      .min(100, "Minimum repayment is ₹1")
      .max(100_000_000, "Amount is too large"),
    method: z.enum(["UPI", "CASH", "BANK_TRANSFER", "OTHER"]),
    paymentReference: reference.optional(),
    evidenceNote,
    evidenceUrl: z
      .string()
      .trim()
      .url()
      .max(500)
      .refine((u) => u.startsWith("https://"), "Evidence link must start with https://")
      .optional(),
    paidAt: z.coerce.date().optional(),
    clientRequestId: z.string().trim().min(8).max(100).regex(/^[A-Za-z0-9_-]+$/),
  })
  .refine((v) => v.method === "CASH" || !!v.paymentReference, {
    message: "A payment reference (UTR / transaction ID) is required for non-cash repayments",
    path: ["paymentReference"],
  });

const STATUSES = [
  "PENDING", "UNDER_REVIEW", "APPROVED", "REJECTED", "DISBURSED",
  "ACTIVE", "PARTIALLY_PAID", "COMPLETED", "OVERDUE",
] as const;

export const loanListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(STATUSES).optional(),
});

export const quoteQuerySchema = z.object({
  principalPaise: z.coerce.number().int().min(10000).max(1_000_000_000),
  installmentCount: z.coerce.number().int().min(1).max(156).optional(),
  repaymentFrequency: frequency.optional(),
});

export type ApplyLoanInput = z.infer<typeof applyLoanSchema>;
export type NoteInput = z.infer<typeof noteSchema>;
export type RejectInput = z.infer<typeof rejectSchema>;
export type DisburseInput = z.infer<typeof disburseSchema>;
export type RepaymentInput = z.infer<typeof repaymentSchema>;
export type LoanListQuery = z.infer<typeof loanListQuerySchema>;
export type QuoteQuery = z.infer<typeof quoteQuerySchema>;