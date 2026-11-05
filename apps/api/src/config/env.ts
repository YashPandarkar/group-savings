import path from "node:path";
import dotenv from "dotenv";
import { z } from "zod";

dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });

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
