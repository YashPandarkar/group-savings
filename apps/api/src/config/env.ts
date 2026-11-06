import path from "node:path";
import dotenv from "dotenv";
import { z } from "zod";

// npm scripts run with the working directory set to apps/api,
// so the repo-root .env is two folders up. (Missing file is fine in production.)
dotenv.config({ path: path.resolve(process.cwd(), "../../.env") });

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  WEB_ORIGIN: z.string().url().default("http://localhost:5173"),
  PAYMENT_MODE: z.enum(["sandbox", "live"]).default("sandbox"),
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

if (env.PAYMENT_MODE === "live" && !env.LEGAL_REVIEW_CONFIRMED) {
  console.error(
    "❌ PAYMENT_MODE=live is blocked until LEGAL_REVIEW_CONFIRMED=true. " +
      "Complete legal and provider review before enabling real-money features."
  );
  process.exit(1);
}
