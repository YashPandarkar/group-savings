import { z } from "zod";
import * as authS from "../modules/auth/auth.schema";
import * as accountS from "../modules/account/account.schema";
import * as groupS from "../modules/groups/groups.schema";
import * as contribS from "../modules/contributions/contributions.schema";
import * as ledgerS from "../modules/ledger/ledger.schema";
import * as loanS from "../modules/loans/loans.schema";
import * as wdS from "../modules/withdrawals/withdrawals.schema";
import * as payS from "../modules/payments/payments.schema";

type Json = Record<string, unknown>;
type Method = "get" | "post" | "put" | "patch" | "delete";
type Auth = "bearer" | "cookie" | "none";

// Request bodies and query strings are generated from the SAME Zod schemas the routes validate with.
// If a conversion ever fails, the label lands here and a test fails, so it can't go unnoticed.
export const schemaFallbacks: string[] = [];

function jsonSchema(schema: z.ZodType, label: string): Json {
  try {
    const out = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Json;
    delete out.$schema;
    return out;
  } catch {
    schemaFallbacks.push(label);
    return { type: "object" };
  }
}

function queryParameters(schema: z.ZodType, label: string): Json[] {
  const js = jsonSchema(schema, label);
  const props = (js.properties ?? {}) as Record<string, Json>;
  const required = new Set((js.required ?? []) as string[]);
  return Object.entries(props).map(([name, s]) => ({ name, in: "query", required: required.has(name), schema: s }));
}

// ───────────── response building blocks ─────────────

const ERRORS: Record<number, string> = {
  400: "BadRequest", 401: "Unauthorized", 403: "Forbidden", 404: "NotFound",
  409: "Conflict", 429: "TooManyRequests", 503: "ProviderUnavailable",
};

const ref = (name: string): Json => ({ $ref: `#/components/schemas/${name}` });
const str: Json = { type: "string" };
const int: Json = { type: "integer" };
const bool: Json = { type: "boolean" };
const when: Json = { type: "string", format: "date-time" };
const nullable = (s: Json): Json => ({ ...s, type: [s.type, "null"] });
const paise = (what: string): Json => ({ type: "integer", description: `${what}, in integer paise (₹1 = 100 paise)` });
const obj = (properties: Json, required?: string[]): Json => ({
  type: "object", properties, ...(required ? { required } : {}), additionalProperties: true,
});
const pageSchema = (item: string): Json =>
  obj({ page: int, pageSize: int, total: int, items: { type: "array", items: ref(item) } });

const errorResponse = (description: string): Json => ({
  description,
  content: { "application/json": { schema: ref("Error") } },
});

const SCHEMAS: Json = {
  Error: obj(
    {
      error: obj(
        {
          code: { type: "string", description: "Stable machine-readable code, e.g. FORBIDDEN, INSUFFICIENT_FUND" },
          message: { type: "string", description: "Safe to show to the user" },
          details: { type: "array", items: obj({ field: str, message: str }) },
        },
        ["code", "message"]
      ),
    },
    ["error"]
  ),
  LoginResult: obj({ accessToken: str, user: obj({ id: str, email: str, name: str }) }, ["accessToken"]),
  Me: obj({
    user: obj({ id: str, email: str, name: str, emailVerifiedAt: nullable(when) }),
    membership: nullable(obj({ groupId: str, groupName: str, role: { enum: ["PRESIDENT", "VICE_PRESIDENT", "MEMBER"] } })),
  }),
  Group: obj({
    id: str, name: str, description: nullable(str), monthlyContributionPaise: paise("Monthly contribution"),
    maxMembers: int, contributionDueDay: int, rules: nullable(str),
    interestMethod: { enum: ["NONE", "FLAT", "REDUCING_BALANCE"] },
    interestRateBps: { type: "integer", description: "Annual rate in basis points (1200 = 12% per year)" },
    defaultRepaymentMonths: int, allowPartialRepayment: bool, allowEarlyRepayment: bool, requireDualApproval: bool,
    payment: obj({ accountHolder: nullable(str), accountNumber: nullable(str), ifsc: nullable(str), upiId: nullable(str) }),
    yourRole: { enum: ["PRESIDENT", "VICE_PRESIDENT", "MEMBER"] }, memberCount: int,
  }),
  Contribution: obj({
    id: str, userId: str, periodYear: int, periodMonth: int, dueDate: when,
    expectedPaise: paise("Expected"), paidPaise: paise("Paid"), remainingPaise: paise("Remaining"),
    status: { enum: ["PENDING", "PARTIAL", "PAID", "WAIVED"] }, overdue: bool, paidLate: bool,
  }),
  Deposit: obj({
    id: str, userId: str, purpose: { enum: ["MONTHLY_DEPOSIT", "ADDITIONAL_DEPOSIT", "LOAN_REPAYMENT"] },
    amountPaise: paise("Amount"), method: str, status: str, reference: nullable(str),
    source: { enum: ["MANUAL", "GATEWAY"], description: "MANUAL = recorded by an administrator; GATEWAY = verified by the payment provider" },
    paidAt: nullable(when), createdAt: when,
  }),
  Transaction: obj({
    id: str, occurredAt: when, type: str, description: str, memberName: nullable(str),
    amountPaise: paise("Amount"),
    bankDeltaPaise: { type: "integer", description: "Positive = money in per the group's records, negative = out, 0 = no cash effect" },
    status: { enum: ["POSTED", "REVERSED", "REVERSAL"] }, reference: nullable(str),
    balanceAfterPaise: { type: "integer", description: "Administrators only" },
  }),
  Loan: obj({
    id: str, borrower: obj({ userId: str, name: str }), principalPaise: paise("Principal"), purpose: str,
    status: { enum: ["PENDING", "UNDER_REVIEW", "APPROVED", "REJECTED", "DISBURSED", "ACTIVE", "PARTIALLY_PAID", "COMPLETED", "OVERDUE"] },
    installmentCount: int, repaymentFrequency: { enum: ["WEEKLY", "MONTHLY"] }, policy: str,
    totalRepayablePaise: nullable(paise("Total to repay")), outstandingPaise: nullable(paise("Outstanding")),
    overdueAmountPaise: paise("Overdue"),
    schedulePreview: { type: ["array", "null"], description: "Shown before disbursement" },
    installments: { type: "array", description: "Present on the detail endpoint, after disbursement" },
  }),
  Withdrawal: obj({
    id: str, kind: { enum: ["MEMBER_PAYOUT", "GROUP_EXPENSE"] }, amountPaise: paise("Amount"), purpose: str,
    status: { enum: ["PENDING", "APPROVED", "REJECTED", "COMPLETED", "CANCELLED"] },
    statusNote: { type: "string", description: "Honest wording: APPROVED means reserved, NOT sent" },
    beneficiary: nullable(obj({ userId: str, name: str })), paymentReference: nullable(str),
  }),
  Notification: obj({ id: str, type: str, title: str, body: str, readAt: nullable(when), createdAt: when }),
  PaymentOrderResult: obj({
    replayed: bool,
    order: obj({ id: str, providerOrderId: str, status: str, amountPaise: paise("Amount") }),
    checkout: obj({ provider: { enum: ["razorpay", "simulator"] }, key: { type: "string", description: "PUBLIC key id only" }, orderId: str }),
  }),
};

const RESPONSES: Json = {
  BadRequest: errorResponse("Validation failed (code VALIDATION_ERROR) or the request was malformed."),
  Unauthorized: errorResponse("Not logged in, or the access token expired (TOKEN_EXPIRED). Call POST /api/auth/refresh."),
  Forbidden: errorResponse("Logged in, but your role (or the rules of the group) doesn't allow this."),
  NotFound: errorResponse("Not found. Records in other groups also look like this, so ids can't be probed."),
  Conflict: errorResponse("The request conflicts with the current state (e.g. INSUFFICIENT_FUND, ALREADY_IN_GROUP)."),
  TooManyRequests: errorResponse("Rate limited. Try again later."),
  ProviderUnavailable: errorResponse("The payment provider is unavailable. Try again shortly."),
};

// ───────────── operations ─────────────

type Op = {
  method: Method; path: string; tag: string; summary: string; description?: string; who?: string;
  auth?: Auth; body?: z.ZodType; rawBody?: string; query?: z.ZodType; headers?: Json[];
  ok?: { status?: number; description: string; ref?: string; pageOf?: string; csv?: boolean };
  errors?: number[];
};

function operation(op: Op): Json {
  const auth = op.auth ?? "bearer";
  const label = `${op.method} ${op.path}`;
  const pathParams = [...op.path.matchAll(/\{(\w+)\}/g)].map((m) => ({
    name: m[1], in: "path", required: true, schema: { type: "string" },
  }));
  const parameters = [...pathParams, ...(op.query ? queryParameters(op.query, label) : []), ...(op.headers ?? [])];

  const okInfo = op.ok ?? { description: "Success" };
  const status = okInfo.status ?? 200;
  const success: Json = { description: okInfo.description };
  if (status !== 204) {
    const schema = okInfo.ref ? ref(okInfo.ref) : okInfo.pageOf ? pageSchema(okInfo.pageOf) : { type: "object", additionalProperties: true };
    success.content = okInfo.csv ? { "text/csv": { schema: { type: "string" } } } : { "application/json": { schema } };
  }

  const codes = new Set<number>([...(auth === "bearer" ? [401] : []), ...(op.body || op.query ? [400] : []), ...(op.errors ?? [])]);
  const responses: Json = { [String(status)]: success };
  for (const c of [...codes].sort()) responses[String(c)] = { $ref: `#/components/responses/${ERRORS[c]}` };

  const description = [op.who ? `**Who can do this:** ${op.who}.` : "", op.description ?? ""].filter(Boolean).join("\n\n");
  return {
    operationId: op.method + op.path.replace(/\{(\w+)\}/g, "_by_$1").replace(/[^A-Za-z0-9]+/g, "_"),
    tags: [op.tag],
    summary: op.summary,
    ...(description ? { description } : {}),
    ...(parameters.length ? { parameters } : {}),
    ...(op.body
      ? { requestBody: { required: true, content: { "application/json": { schema: jsonSchema(op.body, label) } } } }
      : op.rawBody
        ? { requestBody: { required: true, description: op.rawBody, content: { "application/json": { schema: { type: "object" } } } } }
        : {}),
    security: auth === "bearer" ? [{ bearerAuth: [] }] : auth === "cookie" ? [{ refreshCookie: [] }] : [],
    responses,
  };
}

const G = "/api/groups/{groupId}";
const L = "/api/loans/{loanId}";
const W = "/api/withdrawals/{withdrawalId}";
const ADMIN = "President and Vice President";
const PRES = "President";
const notifQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  unread: z.enum(["true", "false"]).optional(),
});
const idemKey: Json = {
  name: "Idempotency-Key", in: "header", required: true,
  description: "One new random value per 'Pay' click. A retry with the same key returns the same order.",
  schema: { type: "string", minLength: 8, maxLength: 100, pattern: "^[A-Za-z0-9_-]+$" },
};

const OPS: Op[] = [
  // Health
  { method: "get", path: "/api/health", tag: "Health", summary: "Is the API alive?", auth: "none", ok: { description: "status, time, paymentMode, paymentProvider" } },
  { method: "get", path: "/api/health/db", tag: "Health", summary: "Can the API reach the database?", auth: "none", ok: { description: "database: up" }, errors: [503] },

  // Authentication
  { method: "post", path: "/api/auth/register", tag: "Authentication", summary: "Create an account", auth: "none", body: authS.registerSchema, ok: { status: 202, description: "Always the same answer, whether or not the email was already registered." }, errors: [429] },
  { method: "post", path: "/api/auth/verify-email", tag: "Authentication", summary: "Verify an email address with the emailed token", auth: "none", body: authS.tokenOnlySchema, errors: [429] },
  { method: "post", path: "/api/auth/resend-verification", tag: "Authentication", summary: "Send a new verification link", auth: "none", body: authS.emailOnlySchema, ok: { status: 202, description: "Same answer for any email." }, errors: [429] },
  { method: "post", path: "/api/auth/login", tag: "Authentication", summary: "Log in", auth: "none", body: authS.loginSchema, description: "Returns a 15-minute access token and sets the HttpOnly refresh cookie (rt).", ok: { description: "Logged in", ref: "LoginResult" }, errors: [401, 403, 429] },
  { method: "post", path: "/api/auth/refresh", tag: "Authentication", summary: "Get a new access token (rotates the refresh cookie)", auth: "cookie", ok: { description: "A new accessToken. Replaying an old refresh token revokes the whole session." }, errors: [401] },
  { method: "post", path: "/api/auth/logout", tag: "Authentication", summary: "Log out (revokes the session)", auth: "cookie", ok: { status: 204, description: "Logged out" } },
  { method: "post", path: "/api/auth/forgot-password", tag: "Authentication", summary: "Email a password-reset link", auth: "none", body: authS.emailOnlySchema, ok: { status: 202, description: "Same answer for any email." }, errors: [429] },
  { method: "post", path: "/api/auth/reset-password", tag: "Authentication", summary: "Set a new password with the emailed token", auth: "none", body: authS.resetPasswordSchema, description: "Logs the user out everywhere.", errors: [429] },
  { method: "get", path: "/api/auth/me", tag: "Authentication", summary: "Who am I, and which group am I in?", ok: { description: "The user and their membership (null when not in a group)", ref: "Me" } },
  { method: "patch", path: "/api/auth/profile", tag: "Authentication", summary: "Update my name", body: accountS.profileSchema, description: "Only the name can change. Email, role and status are ignored." },
  { method: "post", path: "/api/auth/change-password", tag: "Authentication", summary: "Change my password", body: accountS.changePasswordSchema, description: "Keeps this session and logs out all others. A wrong current password is a 400, not a 401.", errors: [429] },

  // Groups, invitations, members
  { method: "post", path: "/api/groups", tag: "Groups", summary: "Create a group (you become President)", body: groupS.createGroupSchema, ok: { status: 201, description: "Created", ref: "Group" }, errors: [409], description: "A user can belong to only one group at a time (ALREADY_IN_GROUP)." },
  { method: "get", path: "/api/groups", tag: "Groups", summary: "My groups (zero or one)", ok: { description: "groups: an array with 0 or 1 items" } },
  { method: "get", path: "/api/groups/me", tag: "Groups", summary: "My group, or null", ok: { description: "group" } },
  { method: "get", path: G, tag: "Groups", summary: "Group details and settings", ok: { description: "The group", ref: "Group" }, errors: [404] },
  { method: "put", path: G, tag: "Groups", summary: "Update group settings", who: PRES, body: groupS.updateGroupSchema, ok: { description: "Updated", ref: "Group" }, errors: [403, 404, 409], description: "Loan terms are copied into each loan when it is applied for, so changes never alter existing loans." },
  { method: "post", path: `${G}/invitations`, tag: "Invitations", summary: "Invite someone by email", who: PRES, body: groupS.inviteSchema, ok: { status: 201, description: "Created" }, errors: [403, 404, 409] },
  { method: "get", path: `${G}/invitations`, tag: "Invitations", summary: "List invitations", who: PRES, errors: [403, 404] },
  { method: "delete", path: `${G}/invitations/{invitationId}`, tag: "Invitations", summary: "Cancel a pending invitation", who: PRES, ok: { status: 204, description: "Cancelled" }, errors: [403, 404] },
  { method: "post", path: "/api/invitations/preview", tag: "Invitations", summary: "Which group is this invitation for?", auth: "none", body: groupS.invitationTokenSchema, errors: [429] },
  { method: "post", path: "/api/invitations/accept", tag: "Invitations", summary: "Accept an invitation", body: groupS.invitationTokenSchema, errors: [403, 409, 429], description: "The logged-in account's verified email must match the invited email." },
  { method: "get", path: `${G}/members`, tag: "Members", summary: "List members", description: "Emails are included only for administrators.", errors: [404] },
  { method: "get", path: `${G}/members/{memberId}`, tag: "Members", summary: "One member", description: "Members can open only their own record. memberId is the membership id.", errors: [404] },
  { method: "put", path: `${G}/members/{memberId}/role`, tag: "Members", summary: "Appoint a Vice President or transfer the presidency", who: PRES, body: groupS.changeRoleSchema, errors: [403, 404] },
  { method: "post", path: `${G}/members/{memberId}/remove`, tag: "Members", summary: "Remove a member", who: PRES, errors: [403, 404, 409], description: "Refused while the member has an open loan, unpaid dues or savings still in the fund." },
  { method: "post", path: `${G}/leave`, tag: "Members", summary: "Leave the group", errors: [404, 409] },

  // Contributions and deposits
  { method: "get", path: `${G}/contributions`, tag: "Contributions and deposits", summary: "Monthly collection dashboard", who: ADMIN, query: contribScheduleQuery(), errors: [403, 404] },
  { method: "get", path: `${G}/contributions/me`, tag: "Contributions and deposits", summary: "My contribution history", errors: [404] },
  { method: "get", path: `${G}/contributions/{memberId}`, tag: "Contributions and deposits", summary: "One member's contribution history", who: ADMIN, errors: [403, 404] },
  { method: "post", path: `${G}/deposits/manual`, tag: "Contributions and deposits", summary: "Record a deposit that arrived outside the app", who: ADMIN, body: contribS.manualDepositSchema, ok: { status: 201, description: "Recorded (200 with replayed=true if clientRequestId was seen before)", ref: "Deposit" }, errors: [403, 404, 409], description: "A record, not proof of money. Nobody can record their own deposit." },
  { method: "get", path: `${G}/deposits`, tag: "Contributions and deposits", summary: "Deposit history", query: contribS.pageQuerySchema, ok: { description: "Own deposits; administrators see all", pageOf: "Deposit" }, errors: [404] },

  // Transactions and reports
  { method: "get", path: `${G}/transactions`, tag: "Transactions and reports", summary: "Search and filter transactions", query: ledgerS.txListQuerySchema, ok: { description: "Members see their own; administrators see all, with running balance", pageOf: "Transaction" }, errors: [404] },
  { method: "get", path: `${G}/transactions/summary`, tag: "Transactions and reports", summary: "Fund balance (per records) and my savings", errors: [404] },
  { method: "get", path: `${G}/transactions/export.csv`, tag: "Transactions and reports", summary: "Download the filtered list as CSV", query: ledgerS.txListQuerySchema, ok: { description: "CSV file (max 5,000 rows); spreadsheet formulas are neutralised", csv: true }, errors: [404] },
  { method: "get", path: `${G}/transactions/{transactionId}`, tag: "Transactions and reports", summary: "One transaction with its debit and credit lines", errors: [404] },
  { method: "post", path: `${G}/transactions/{transactionId}/reverse`, tag: "Transactions and reports", summary: "Reverse a deposit (the only way to correct one)", who: PRES, body: ledgerS.reverseSchema, ok: { status: 201, description: "Reversal journal created" }, errors: [403, 404, 409] },
  { method: "get", path: `${G}/reports/fund`, tag: "Transactions and reports", summary: "Fund balance, member-wise savings, totals by type", who: ADMIN, errors: [403, 404] },
  { method: "get", path: `${G}/reports/monthly`, tag: "Transactions and reports", summary: "Monthly (and, for a year, annual) savings", who: ADMIN, query: ledgerS.yearQuerySchema, errors: [403, 404] },
  { method: "get", path: `${G}/reports/integrity`, tag: "Transactions and reports", summary: "Check that the books are consistent", who: ADMIN, errors: [403, 404], description: "Proves the records agree with each other, not that they match the bank." },

  // Loans
  { method: "post", path: `${G}/loans`, tag: "Loans", summary: "Apply for a loan", body: loanS.applyLoanSchema, ok: { status: 201, description: "Applied (200 with replayed=true on an immediate repeat)" }, errors: [404, 409], description: "Interest terms are copied from the group's policy and can't be supplied by the applicant." },
  { method: "get", path: `${G}/loans`, tag: "Loans", summary: "List loans", query: loanS.loanListQuerySchema, ok: { description: "Own loans; administrators see all", pageOf: "Loan" }, errors: [404] },
  { method: "get", path: `${G}/loans/quote`, tag: "Loans", summary: "What would I repay?", query: loanS.quoteQuerySchema, errors: [404] },
  { method: "get", path: `${G}/loans/outstanding`, tag: "Loans", summary: "Outstanding and overdue loans", who: ADMIN, errors: [403, 404] },
  { method: "get", path: L, tag: "Loans", summary: "Loan detail with terms and installments", description: "Also available as /api/groups/{groupId}/loans/{loanId}.", ok: { description: "The loan", ref: "Loan" }, errors: [404] },
  { method: "post", path: `${L}/review`, tag: "Loans", summary: "Mark under review", who: ADMIN, body: loanS.noteSchema, errors: [403, 404, 409] },
  { method: "post", path: `${L}/approve`, tag: "Loans", summary: "Approve a loan", who: "The President (the Vice President for the President's own loan)", body: loanS.noteSchema, errors: [403, 404, 409], description: "Fixes the total repayable. Approved means authorised, not sent." },
  { method: "post", path: `${L}/reject`, tag: "Loans", summary: "Reject a loan", who: "Same as approve", body: loanS.rejectSchema, errors: [403, 404, 409] },
  { method: "post", path: `${L}/disburse`, tag: "Loans", summary: "Record that the money was sent", who: "Same as approve", body: loanS.disburseSchema, errors: [403, 404, 409], description: "Records a real transfer made outside the app, with its reference. Creates the installment schedule." },
  { method: "post", path: `${L}/cancel`, tag: "Loans", summary: "Withdraw my application", errors: [404, 409] },
  { method: "get", path: `${L}/installments`, tag: "Loans", summary: "Installment schedule", errors: [404] },
  { method: "get", path: `${L}/repayments`, tag: "Loans", summary: "Repayment history", errors: [404] },
  { method: "post", path: `${L}/repayments`, tag: "Loans", summary: "Record a repayment that arrived outside the app", who: ADMIN, body: loanS.repaymentSchema, ok: { status: 201, description: "Recorded (200 with replayed=true on a repeat)" }, errors: [403, 404, 409] },

  // Withdrawals
  { method: "post", path: `${G}/withdrawals`, tag: "Withdrawals", summary: "Request a withdrawal", who: ADMIN, body: wdS.requestWithdrawalSchema, ok: { status: 201, description: "Requested", ref: "Withdrawal" }, errors: [403, 404, 409], description: "Records an authorisation only. No money moves until the transfer is recorded as completed." },
  { method: "get", path: `${G}/withdrawals`, tag: "Withdrawals", summary: "List withdrawals", query: wdS.withdrawalListQuerySchema, ok: { description: "Administrators see all; members only payouts made to them", pageOf: "Withdrawal" }, errors: [404] },
  { method: "get", path: `${G}/withdrawals/report`, tag: "Withdrawals", summary: "Withdrawal totals and list", who: ADMIN, errors: [403, 404] },
  { method: "get", path: W, tag: "Withdrawals", summary: "One withdrawal", ok: { description: "The withdrawal", ref: "Withdrawal" }, errors: [404] },
  { method: "post", path: `${W}/approve`, tag: "Withdrawals", summary: "Second approval", who: "The other administrator", body: wdS.noteSchema, errors: [403, 404, 409] },
  { method: "post", path: `${W}/reject`, tag: "Withdrawals", summary: "Reject", who: "An administrator other than the requester", body: wdS.rejectSchema, errors: [403, 404, 409] },
  { method: "post", path: `${W}/cancel`, tag: "Withdrawals", summary: "Withdraw my request", who: "The requester", errors: [403, 404, 409] },
  { method: "post", path: `${W}/complete`, tag: "Withdrawals", summary: "Record that the transfer was really made", who: ADMIN, body: wdS.completeSchema, errors: [403, 404, 409], description: "Moves the ledger. The beneficiary can't record their own payout." },

  // Payments
  { method: "get", path: "/api/payments/config", tag: "Payments", summary: "Payment mode, provider and PUBLIC key id" },
  { method: "post", path: "/api/payments/create-order", tag: "Payments", summary: "Create a payment order", body: payS.createOrderSchema, headers: [idemKey], ok: { status: 201, description: "Created (200 on a replay)", ref: "PaymentOrderResult" }, errors: [403, 404, 409, 429, 503] },
  { method: "post", path: "/api/payments/verify", tag: "Payments", summary: "After checkout: verify and apply", body: payS.verifySchema, errors: [404, 429, 503], description: "Verifies the signature, then asks the provider's API. The browser's word alone never confirms money." },
  { method: "get", path: "/api/payments/{orderId}", tag: "Payments", summary: "Order status (poll after checkout)", errors: [404] },
  { method: "post", path: "/api/payments/webhook", tag: "Payments", summary: "Provider webhook", auth: "none", rawBody: "The exact raw bytes the provider sent.", headers: [
      { name: "X-Razorpay-Signature", in: "header", required: true, schema: { type: "string" } },
      { name: "X-Razorpay-Event-Id", in: "header", required: false, schema: { type: "string" } },
    ], description: "Called by the payment provider only. The HMAC signature is checked on the raw body, duplicates are ignored, and the payment is re-fetched from the provider.", ok: { description: "Received" } },

  // Notifications
  { method: "get", path: "/api/notifications", tag: "Notifications", summary: "My notifications", query: notifQuery, ok: { description: "Includes the unread count", pageOf: "Notification" } },
  { method: "get", path: "/api/notifications/unread-count", tag: "Notifications", summary: "Number of unread notifications" },
  { method: "post", path: "/api/notifications/read-all", tag: "Notifications", summary: "Mark all as read" },
  { method: "post", path: "/api/notifications/{id}/read", tag: "Notifications", summary: "Mark one as read", errors: [404] },
];

function contribScheduleQuery(): z.ZodType {
  return contribS.periodQuerySchema;
}

// ───────────── the document ─────────────

const paths: Record<string, Json> = {};
for (const op of OPS) paths[op.path] = { ...(paths[op.path] ?? {}), [op.method]: operation(op) };

export const openApiDocument: Json = {
  openapi: "3.1.0",
  info: {
    title: "Group Savings and Loans API",
    version: "1.0.0",
    description: [
      "REST API for group savings, member loans and the group ledger.",
      "**Money** is always integer paise (1 rupee = 100 paise). Interest rates are annual basis points (1200 = 12% per year). Dates are ISO 8601 in UTC.",
      "**Errors** always look like {error: {code, message, details?}}.",
      "**Authentication:** log in to receive a 15-minute access token (send it as Authorization: Bearer ...). A rotating refresh token lives in an HttpOnly cookie and is used only by /api/auth/refresh and /api/auth/logout.",
      "**Records, not bank balances:** balances come from the group's ledger. A recorded deposit, repayment, disbursement or withdrawal is an administrator's record of a transfer made outside the app, with its reference. The app itself moves no money.",
      "**Sandbox:** unless the server runs in live mode, payments are test payments.",
    ].join("\n\n"),
  },
  servers: [{ url: "/" }],
  tags: [...new Set(OPS.map((o) => o.tag))].map((name) => ({ name })),
  paths,
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      refreshCookie: { type: "apiKey", in: "cookie", name: "rt" },
    },
    schemas: SCHEMAS,
    responses: RESPONSES,
  },
};
