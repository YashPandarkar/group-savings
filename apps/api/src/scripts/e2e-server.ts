import path from "node:path";
import dotenv from "dotenv";
import { derivedUrls, E2E_MAIL_FILE } from "./dbNames";

// Starts the API for the browser tests: its own database, the payment simulator, the built web app on the
// same origin, and emails written to a file. NODE_ENV=test also switches off rate limiting.
dotenv.config({ path: path.resolve(process.cwd(), "../../.env") });

const port = process.env.E2E_PORT ?? "4100";
Object.assign(process.env, {
  DATABASE_URL: derivedUrls("e2e").target,
  NODE_ENV: "test",
  PORT: port,
  WEB_ORIGIN: `http://localhost:${port}`,
  SERVE_WEB: "true",
  PAYMENT_MODE: "sandbox",
  PAYMENT_PROVIDER: "simulator",
  LEGAL_REVIEW_CONFIRMED: "false",
  E2E_MAIL_FILE,
});
process.env.JWT_ACCESS_SECRET ??= "e2e-only-secret-e2e-only-secret-123456";
process.env.DATA_ENCRYPTION_KEY ??= "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

void import("../server.js");
