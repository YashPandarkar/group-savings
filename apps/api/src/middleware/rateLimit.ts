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
// Login: tight, to slow down password guessing.
export const loginLimiter = rateLimit({ ...common, windowMs: 15 * 60 * 1000, limit: 10 });
// Register / forgot-password / resend: stops email spam.
export const authLimiter = rateLimit({ ...common, windowMs: 15 * 60 * 1000, limit: 20 });
// Creating payment orders: every call reaches the payment provider.
export const paymentLimiter = rateLimit({ ...common, windowMs: 15 * 60 * 1000, limit: 30 });
