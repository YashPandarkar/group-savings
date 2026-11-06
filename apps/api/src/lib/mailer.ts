import { env } from "../config/env";

export type Email = { to: string; subject: string; text: string };

// Used by tests to read "sent" emails.
export const outbox: Email[] = [];

export async function sendEmail(email: Email): Promise<void> {
  if (env.NODE_ENV === "test") {
    outbox.push(email);
    return;
  }
  // TODO (Phase 16): send through a real email provider.
  console.log("\n📧 ── EMAIL (dev: printed, not sent) ──────────────");
  console.log(`To: ${email.to}\nSubject: ${email.subject}\n\n${email.text}`);
  console.log("───────────────────────────────────────────────────\n");
}
