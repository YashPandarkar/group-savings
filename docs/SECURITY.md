# Security checklist

Status key: **TEST** = enforced by an automated test, **CODE** = verified by reading the code, **MANUAL** = check by hand,
**LATER** = scheduled for a later phase, **RISK** = known and accepted.

## Authentication
- [x] Passwords hashed with Argon2id (CODE). Minimum 10 characters with a letter and a number (TEST: auth, account).
- [x] Same response for unknown email, wrong password and deactivated user; dummy hash keeps timing similar (TEST: auth).
- [x] Same response when registering an email that already exists (TEST: auth).
- [x] Login blocked until the email is verified (TEST: auth).
- [x] Login rate limits: 10 per 15 minutes per IP, and 8 failed attempts per 15 minutes per email (TEST: ratelimit).
- [x] 15-minute access token (HS256 only); refresh token in an HttpOnly, SameSite=Strict, Path=/api/auth cookie (TEST: auth). Add `Secure` check in production (MANUAL).
- [x] Refresh tokens are rotated; replaying an old one revokes the whole session (TEST: auth).
- [x] Only SHA-256 hashes of refresh, verification and reset tokens are stored (TEST: auth).
- [x] Password reset links are single-use and expire in 1 hour; reset logs out all sessions (TEST: auth).
- [x] Changing the password logs out all other sessions (TEST: account).
- [ ] Mobile OTP / MFA: not implemented. RISK: password plus email only.
- [ ] RISK: an access token stays valid for up to 15 minutes after a password change. Fix needs a token-version column.

## Authorization and tenant isolation
- [x] Three-layer chain on every group route: logged in, active member of THIS group, role permits the action (TEST: security matrix).
- [x] Every protected endpoint returns 401 without a token (TEST: security matrix).
- [x] Administrator-only endpoints return 403 to members; President-only ones return 403 to the Vice President (TEST: security matrix).
- [x] Another group's President gets 404 on every group-scoped endpoint (TEST: security matrix, groups, deposits, loans, withdrawals).
- [x] Records fetched by id are re-checked against the caller's group (TEST: loans, withdrawals, transactions).
- [x] Roles can't be changed through any profile endpoint (TEST: account).
- [x] Separation of duties: nobody records their own deposit or repayment, decides their own loan, approves their own request, or completes their own payout (TEST: deposits, loans, withdrawals).
- [ ] New endpoints must be added to `OPS` in `apps/api/src/docs/openapi.ts`, or the matrix won't cover them (process rule).

## Money integrity
- [x] Money is integer paise; interest as basis points; no floating point (CODE, TEST: interest).
- [x] Ledger is double-entry, append-only (database triggers) and balanced at commit (TEST: verify-db script, ledger).
- [x] Corrections are reversals, never edits; reversals respect reserved money (TEST: transactions, security).
- [x] Group row lock on every money-moving operation (TEST: concurrency).
- [x] Idempotency on deposits, repayments, payment orders, webhooks and reversals (TEST: deposits, loans, payments, concurrency).
- [x] Books-consistency report (TEST: transactions, loans, payments).
- [x] Approved never means sent: the UI and API say so (TEST: withdrawals, journey E2E).

## Payments
- [x] Success is never taken from the browser: signature check, then a server-side fetch from the provider (TEST: payments).
- [x] Webhook signature verified on the raw body; duplicates ignored; amount must match the order (TEST: payments).
- [x] No card or UPI credentials stored; provider payloads stored minimised (TEST: payments).
- [x] Provider secrets only in environment variables; the frontend gets only the public key id (TEST: payments, security source scan).
- [x] The payment simulator can't run in production or live mode (TEST: envguard).
- [x] Live mode needs LEGAL_REVIEW_CONFIRMED and a matching live key (TEST: envguard).
- [ ] Refunds and disputes are flagged, not auto-unwound (RISK, by design; see Phase 9).
- [ ] Real Razorpay checkout, CSP hosts and webhook delivery: LATER (needs a test-mode account).

## Input and output
- [x] Every request body and query string is validated with Zod; unknown fields are dropped (CODE, TEST: many).
- [x] SQL: Prisma parameterised queries; raw queries use tagged templates only (TEST: security source scan).
- [x] CSV export neutralises formula injection (TEST: transactions).
- [x] No raw HTML injection in the frontend (TEST: security source scan).
- [x] Request bodies limited to 100 KB (webhook 1 MB) (CODE).
- [x] Error responses never contain stack traces or internals (TEST: connection).

## Browser and transport
- [x] Helmet headers with a strict Content-Security-Policy (TEST: connection).
- [x] CORS allows only the configured web origin with credentials, never `*` (TEST: connection).
- [x] Origin check on mutating requests from browsers (TEST: auth, connection).
- [x] Access token kept in memory only; nothing in localStorage or sessionStorage (TEST: security source scan, E2E).
- [x] Production requires an https:// origin (TEST: envguard). HSTS comes from Helmet over HTTPS (MANUAL).
- [ ] CSRF: the access token travels in a header, and the cookie endpoints are protected by SameSite=Strict plus the origin check. No separate CSRF token (CODE, by design).

## Data protection
- [x] Group bank account numbers encrypted at rest (AES-256-GCM) (TEST: groups). Members can see them by design.
- [x] Audit log is append-only and covers logins, role changes, deposits, loans, withdrawals, reversals, exports (TEST: many).
- [x] One-time links are never written to production logs (CODE, section 3.1).
- [ ] Encryption key rotation procedure: LATER (Phase 16). Losing the key loses the stored account numbers.
- [ ] Data-protection obligations (consent, retention, deletion, breach notification): needs legal review. RISK until done.

## Operations
- [x] Secrets only in environment variables; `.env` is not tracked (MANUAL: run the scans in Phase 14, section 5).
- [x] Production refuses placeholder secrets and the public test key (TEST: envguard).
- [ ] Dependency audit on every push, non-blocking (CI job added); review findings regularly (PROCESS).
- [ ] Rate limits are in memory: fine for one instance, needs a shared store for several (LATER).
- [ ] Monitoring, alerting on repeated failures, and backups (LATER, Phase 16).
