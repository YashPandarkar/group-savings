import path from "node:path";
import dotenv from "dotenv";
import { z } from "zod";

// npm scripts run with the working directory set to apps/api,
// so the repo-root .env is two folders up. (Missing file is fine in production.)
dotenv.config({ path: path.resolve(process.cwd(), "../../.env") });

// An empty "KEY=" line in .env counts as "not set".
const optionalText = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  z.string().trim().min(1).optional()
);

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  WEB_ORIGIN: z.string().url().default("http://localhost:5173"),
  PAYMENT_MODE: z.enum(["sandbox", "live"]).default("sandbox"),
  PAYMENT_PROVIDER: z.enum(["simulator", "razorpay"]).default("simulator"),
  LEGAL_REVIEW_CONFIRMED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  JWT_ACCESS_SECRET: z.string().min(32, "must be at least 32 characters (openssl rand -hex 32)"),
  DATA_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, "must be exactly 64 hex characters (openssl rand -hex 32)"),
  ACCESS_TOKEN_TTL_MIN: z.coerce.number().int().positive().default(15),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  RAZORPAY_KEY_ID: optionalText,
  RAZORPAY_KEY_SECRET: optionalText,
  RAZORPAY_WEBHOOK_SECRET: optionalText,
  // Serve the built web app (apps/web/dist) from this API: one origin, so cookies and CORS just work.
  SERVE_WEB: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  WEB_DIST: optionalText,
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment configuration:");
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;

const problems: string[] = [];

// Safety gate from Phase 1: real-money mode requires explicit confirmation.
if (env.PAYMENT_MODE === "live" && !env.LEGAL_REVIEW_CONFIRMED) {
  problems.push(
    "PAYMENT_MODE=live is blocked until LEGAL_REVIEW_CONFIRMED=true. " +
      "Complete legal and provider review before enabling real-money features."
  );
}

if (env.PAYMENT_PROVIDER === "razorpay") {
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET || !env.RAZORPAY_WEBHOOK_SECRET) {
    problems.push("PAYMENT_PROVIDER=razorpay needs RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET.");
  } else {
    const prefix = env.PAYMENT_MODE === "live" ? "rzp_live_" : "rzp_test_";
    if (!env.RAZORPAY_KEY_ID.startsWith(prefix)) {
      problems.push(`PAYMENT_MODE=${env.PAYMENT_MODE} requires a Razorpay key that starts with ${prefix}.`);
    }
  }
} else {
  if (env.PAYMENT_MODE === "live") problems.push("The payment simulator can't be used with PAYMENT_MODE=live.");
  if (env.NODE_ENV === "production") problems.push("The payment simulator can't run when NODE_ENV=production.");
}

if (problems.length > 0) {
  console.error("❌ Unsafe payment configuration:");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
