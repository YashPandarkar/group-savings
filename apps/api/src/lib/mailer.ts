import fs from "node:fs";
import { env } from "../config/env";

export type Email = { to: string; subject: string; text: string };

// Used by the API tests to read "sent" emails.
export const outbox: Email[] = [];

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
  // TODO (Phase 16): send through a real email provider.
  console.log("\n📧 ── EMAIL (dev: printed, not sent) ──────────────");
  console.log(`To: ${email.to}\nSubject: ${email.subject}\n\n${email.text}`);
  console.log("───────────────────────────────────────────────────\n");
}
