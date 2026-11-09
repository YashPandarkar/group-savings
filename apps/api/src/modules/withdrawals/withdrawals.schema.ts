import { z } from "zod";

// Money is integer PAISE (₹2,000 = 200000).
const reference = z
  .string()
  .trim()
  .min(6)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "Use letters, numbers, - and _ only");

export const requestWithdrawalSchema = z
  .object({
    kind: z.enum(["MEMBER_PAYOUT", "GROUP_EXPENSE"]),
    beneficiaryUserId: z.string().uuid().optional(), // whose savings are paid out
    amountPaise: z
      .number()
      .int("Amount must be a whole number of paise")
      .min(100, "Minimum withdrawal is ₹1")
      .max(1_000_000_000, "Amount is too large"),
    purpose: z.string().trim().min(5, "Describe the purpose").max(300),
  })
  .refine((v) => (v.kind === "MEMBER_PAYOUT") === (v.beneficiaryUserId !== undefined), {
    message: "beneficiaryUserId is required for member payouts, and not allowed for group expenses",
    path: ["beneficiaryUserId"],
  });

export const noteSchema = z.object({ note: z.string().trim().max(500).optional() }).default({});

export const rejectSchema = z.object({
  reason: z.string().trim().min(10, "Explain the reason (at least 10 characters)").max(500),
});

// Records that a REAL transfer was made, outside this app.
export const completeSchema = z
  .object({
    method: z.enum(["BANK_TRANSFER", "UPI", "CASH", "OTHER"]),
    reference: reference.optional(), // UTR / bank transaction ID of the real transfer
    note: z.string().trim().min(5, "Describe the evidence (e.g. 'UTR checked in the bank app')").max(500),
  })
  .refine((v) => v.method === "CASH" || !!v.reference, {
    message: "A transfer reference (UTR / transaction ID) is required for non-cash transfers",
    path: ["reference"],
  });

export const withdrawalListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(["PENDING", "APPROVED", "REJECTED", "COMPLETED", "CANCELLED"]).optional(),
});

export type RequestWithdrawalInput = z.infer<typeof requestWithdrawalSchema>;
export type NoteInput = z.infer<typeof noteSchema>;
export type RejectInput = z.infer<typeof rejectSchema>;
export type CompleteInput = z.infer<typeof completeSchema>;
export type WithdrawalListQuery = z.infer<typeof withdrawalListQuerySchema>;
