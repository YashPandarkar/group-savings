import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import dotenv from "dotenv";
import { Client } from "pg";
import { derivedUrls, E2E_MAIL_FILE } from "./dbNames";

dotenv.config({ path: path.resolve(process.cwd(), "../../.env") });

// Drops and recreates <name>_test or <name>_e2e, then applies every migration.
// Usage: tsx src/scripts/reset-db.ts <test|e2e>
async function main() {
  const kind = process.argv[2];
  if (kind !== "test" && kind !== "e2e") {
    console.error("Usage: reset-db.ts <test|e2e>");
    process.exit(1);
  }
  const { name, target, admin } = derivedUrls(kind);

  const client = new Client({ connectionString: admin });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await client.query(`CREATE DATABASE "${name}"`);
  } finally {
    await client.end();
  }
  console.log(`Created a fresh database "${name}". Applying migrations...`);
  execSync("npx prisma migrate deploy", { stdio: "inherit", env: { ...process.env, DATABASE_URL: target } });

  if (kind === "e2e") fs.rmSync(E2E_MAIL_FILE, { force: true });
  console.log(`✅ ${name} is ready.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
