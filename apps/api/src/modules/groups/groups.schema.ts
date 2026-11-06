import { z } from "zod";

// Money fields are integer PAISE (₹200 = 20000). The frontend converts rupees to paise.
const f = {
  name: z.string().trim().min(3, "Name must be at least 3 characters").max(80),
  description: z.string().trim().max(500),
  logoUrl: z
    .string()
    .trim()
    .url("Enter a valid URL")
    .max(500)
    .refine((u) => u.startsWith("https://"), "Logo URL must start with https://"),
  monthlyContributionPaise: z
    .number()
    .int("Amount must be a whole number of paise")
    .min(1000, "Minimum contribution is ₹10")
    .max(100_000_000, "Maximum contribution is ₹10,00,000"),
  maxMembers: z.number().int().min(10, "A group needs 10 to 20 members").max(20, "A group needs 10 to 20 members"),
  contributionDueDay: z.number().int().min(1).max(28),
  rules: z.string().trim().max(5000),
  interestMethod: z.enum(["NONE", "FLAT", "REDUCING_BALANCE"]),
  interestRateBps: z.number().int().min(0).max(10000), // basis points: 12% = 1200
  defaultRepaymentMonths: z.number().int().min(1).max(60),
  allowPartialRepayment: z.boolean(),
  allowEarlyRepayment: z.boolean(),
  requireDualApproval: z.boolean(),
  bankAccountHolder: z.string().trim().min(2).max(100),
  bankAccountNumber: z.string().trim().regex(/^[0-9]{9,18}$/, "Account number must be 9 to 18 digits"),
  bankIfsc: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, "Enter a valid IFSC code"),
  upiId: z
    .string()
    .trim()
    .regex(/^[a-zA-Z0-9._-]{2,256}@[a-zA-Z]{2,64}$/, "Enter a valid UPI ID"),
};

// Unknown fields (like "createdById" or "role") are silently dropped by zod,
// so a client can't smuggle extra data into the database.
export const createGroupSchema = z.object({
  name: f.name,
  description: f.description.optional(),
  logoUrl: f.logoUrl.optional(),
  monthlyContributionPaise: f.monthlyContributionPaise.default(20000),
  maxMembers: f.maxMembers.default(10),
  contributionDueDay: f.contributionDueDay.default(10),
  rules: f.rules.optional(),
  interestMethod: f.interestMethod.default("NONE"),
  interestRateBps: f.interestRateBps.default(0),
  defaultRepaymentMonths: f.defaultRepaymentMonths.default(12),
  allowPartialRepayment: f.allowPartialRepayment.default(true),
  allowEarlyRepayment: f.allowEarlyRepayment.default(true),
  requireDualApproval: f.requireDualApproval.default(false),
  bankAccountHolder: f.bankAccountHolder.optional(),
  bankAccountNumber: f.bankAccountNumber.optional(),
  bankIfsc: f.bankIfsc.optional(),
  upiId: f.upiId.optional(),
});

export const updateGroupSchema = z
  .object({
    name: f.name.optional(),
    description: f.description.optional(), // "" clears it
    logoUrl: f.logoUrl.optional(),
    monthlyContributionPaise: f.monthlyContributionPaise.optional(),
    maxMembers: f.maxMembers.optional(),
    contributionDueDay: f.contributionDueDay.optional(),
    rules: f.rules.optional(), // "" clears it
    interestMethod: f.interestMethod.optional(),
    interestRateBps: f.interestRateBps.optional(),
    defaultRepaymentMonths: f.defaultRepaymentMonths.optional(),
    allowPartialRepayment: f.allowPartialRepayment.optional(),
    allowEarlyRepayment: f.allowEarlyRepayment.optional(),
    requireDualApproval: f.requireDualApproval.optional(),
    bankAccountHolder: f.bankAccountHolder.optional(),
    bankAccountNumber: f.bankAccountNumber.optional(),
    bankIfsc: f.bankIfsc.optional(),
    upiId: f.upiId.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), "Nothing to update");

export const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email").max(254),
});

export const invitationTokenSchema = z.object({ token: z.string().min(20).max(200) });

export const changeRoleSchema = z.object({
  role: z.enum(["PRESIDENT", "VICE_PRESIDENT", "MEMBER"]),
});

export type CreateGroupInput = z.infer<typeof createGroupSchema>;
export type UpdateGroupInput = z.infer<typeof updateGroupSchema>;
export type InviteInput = z.infer<typeof inviteSchema>;
export type InvitationTokenInput = z.infer<typeof invitationTokenSchema>;
export type ChangeRoleInput = z.infer<typeof changeRoleSchema>;
