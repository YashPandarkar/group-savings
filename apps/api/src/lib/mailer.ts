import fs from "node:fs";
import { env } from "../config/env";

export type Email = { to: string; subject: string; text: string };

// Used by the API tests to read "sent" emails.
export const outbox: Email[] = [];

// a***@example.com : enough to debug, not enough to expose the address in logs.
const mask = (address: string) => address.replace(/^(.).*(@.*)$/, "$1***$2");

export async function sendEmail(email: Email): Promise<void> {
  // Browser tests read emails from a file (env.ts refuses this setting in production).
  if (env.E2E_MAIL_FILE) {
    fs.appendFileSync(env.E2E_MAIL_FILE, JSON.stringify(email) + "\n");
    return;
  }
  if (env.NODE_ENV === "test") {
    outbox.push(email);
    return;
  }
  if (env.NODE_ENV === "production") {
    // The body holds a one-time login/reset link: it must NEVER reach the logs.
    // TODO (Phase 16): send through a real email provider here.
    console.warn(`Email NOT sent (no email provider configured): to=${mask(email.to)} subject="${email.subject}"`);
    return;
  }
  console.log("\n📧 ── EMAIL (dev: printed, not sent) ──────────────");
  console.log(`To: ${email.to}\nSubject: ${email.subject}\n\n${email.text}`);
  console.log("───────────────────────────────────────────────────\n");
}
