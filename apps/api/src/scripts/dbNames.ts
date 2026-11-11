import os from "node:os";
import path from "node:path";

export type DbKind = "test" | "e2e";

// Where the E2E server writes emails and the Playwright tests read them (keep in sync with e2e/helpers.ts).
export const E2E_MAIL_FILE = path.join(os.tmpdir(), "groupsavings-e2e-mail.jsonl");

// Derives <name>_test or <name>_e2e from DATABASE_URL, so these databases can never be your real one.
export function derivedUrls(kind: DbKind) {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is not set (check the .env file in the repository root).");

  const baseName = decodeURIComponent(new URL(raw).pathname.replace(/^\//, ""));
  if (!baseName) throw new Error("DATABASE_URL has no database name.");
  const name = `${baseName.replace(/_(test|e2e)$/, "")}_${kind}`;
  if (!/^[A-Za-z0-9_]+$/.test(name) || !/_(test|e2e)$/.test(name)) {
    throw new Error(`Refusing to use the database name "${name}".`);
  }

  const target = new URL(raw);
  target.pathname = `/${name}`;
  const admin = new URL(raw);
  admin.pathname = "/postgres";
  return { name, target: target.toString(), admin: admin.toString() };
}
