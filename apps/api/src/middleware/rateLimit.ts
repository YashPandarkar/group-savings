import rateLimit from "express-rate-limit";
import { env } from "../config/env";

const common = {
  standardHeaders: "draft-7" as const,
  legacyHeaders: false,
  skip: () => env.NODE_ENV === "test", // tests make many calls
  message: { error: { code: "RATE_LIMITED", message: "Too many requests. Please try again later." } },
};

// Whole API: generous.
export const apiLimiter = rateLimit({ ...common, windowMs: 60 * 1000, limit: 300 });
// Login: tight, to slow down password guessing from one place.
export const loginLimiter = rateLimit({ ...common, windowMs: 15 * 60 * 1000, limit: 10 });
// Register / forgot-password / resend: stops email spam.
export const authLimiter = rateLimit({ ...common, windowMs: 15 * 60 * 1000, limit: 20 });
// Creating payment orders: every call reaches the payment provider.
export const paymentLimiter = rateLimit({ ...common, windowMs: 15 * 60 * 1000, limit: 30 });

// Counts FAILED attempts per email address, whatever IP they come from, so a spread-out attack on one
// account is slowed too. Successful requests aren't counted. Tradeoff: someone who knows an email can
// make that account's login wait up to the window. Parameters are exposed so tests can exercise it.
export function makeEmailLimiter(opts: { limit: number; windowMs: number; skip?: () => boolean }) {
  return rateLimit({
    ...common,
    windowMs: opts.windowMs,
    limit: opts.limit,
    skip: opts.skip ?? common.skip,
    skipSuccessfulRequests: true,
    keyGenerator: (req) => {
      const email = (req.body as { email?: unknown } | undefined)?.email;
      return typeof email === "string" ? email.trim().toLowerCase().slice(0, 254) : "no-email";
    },
  });
}
export const loginEmailLimiter = makeEmailLimiter({ limit: 8, windowMs: 15 * 60 * 1000 });
