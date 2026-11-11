import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// A valid production-style setup (Razorpay TEST keys: a staging deployment).
const GOOD: Record<string, string> = {
  NODE_ENV: "production",
  PORT: "4000",
  DATABASE_URL: "postgresql://app:Str0ngPassw0rd@db.example.com:5432/app",
  WEB_ORIGIN: "https://app.example.com",
  PAYMENT_MODE: "sandbox",
  PAYMENT_PROVIDER: "razorpay",
  RAZORPAY_KEY_ID: "rzp_test_abc123",
  RAZORPAY_KEY_SECRET: "secret",
  RAZORPAY_WEBHOOK_SECRET: "whsec",
  LEGAL_REVIEW_CONFIRMED: "false",
  JWT_ACCESS_SECRET: "a".repeat(64),
  DATA_ENCRYPTION_KEY: "ab".repeat(32),
  E2E_MAIL_FILE: "",
  SERVE_WEB: "false",
};

// Loads the real configuration in a separate process, because a bad one calls process.exit(1).
function load(over: Record<string, string> = {}) {
  return spawnSync("npx", ["tsx", "src/scripts/check-env.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, ...GOOD, ...over },
    encoding: "utf8",
    timeout: 45_000,
  });
}
const refused = (over: Record<string, string>, message: RegExp) => {
  const r = load(over);
  expect(r.status, r.stdout + r.stderr).toBe(1);
  expect(r.stderr).toMatch(message);
};

describe("production configuration guards", () => {
  it("accepts a sound configuration", () => {
    const r = load();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("ENV_OK production");
  }, 60_000);

  it("refuses an http origin", () => refused({ WEB_ORIGIN: "http://app.example.com" }, /https:\/\//), 60_000);
  it("refuses the placeholder database password", () => refused({ DATABASE_URL: "postgresql://groupsavings:change_me_local_only@db.example.com:5432/app" }, /placeholder/), 60_000);
  it("refuses a test JWT secret", () => refused({ JWT_ACCESS_SECRET: "test-only-secret-test-only-secret-1234" }, /JWT_ACCESS_SECRET/), 60_000);
  it("refuses the public test encryption key", () => refused({ DATA_ENCRYPTION_KEY: "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff" }, /DATA_ENCRYPTION_KEY/), 60_000);
  it("refuses the payment simulator", () => refused({ PAYMENT_PROVIDER: "simulator" }, /simulator/), 60_000);
  it("refuses live payments without the legal-review confirmation", () => refused({ PAYMENT_MODE: "live", RAZORPAY_KEY_ID: "rzp_live_abc123" }, /LEGAL_REVIEW_CONFIRMED/), 60_000);
  it("refuses test keys in live mode", () => refused({ PAYMENT_MODE: "live", LEGAL_REVIEW_CONFIRMED: "true" }, /rzp_live_/), 60_000);
  it("refuses the browser-test mail file", () => refused({ E2E_MAIL_FILE: "/tmp/mail.jsonl" }, /E2E_MAIL_FILE/), 60_000);
});
