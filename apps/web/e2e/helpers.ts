import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Page } from "@playwright/test";

// Must match E2E_MAIL_FILE in apps/api/src/scripts/dbNames.ts
export const MAIL_FILE = path.join(os.tmpdir(), "groupsavings-e2e-mail.jsonl");
export const PASSWORD = "CorrectHorse42";

let counter = 0;
export const uniqueEmail = (label: string) => `${label}.${Date.now()}.${++counter}@e2e.test`;

type Mail = { to: string; subject: string; text: string };

function readMail(): Mail[] {
  if (!fs.existsSync(MAIL_FILE)) return [];
  return fs.readFileSync(MAIL_FILE, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Mail);
}

// The first link in the newest email to `to` whose subject contains `subjectPart`.
export async function waitForLink(to: string, subjectPart: string): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const mail = [...readMail()].reverse().find((m) => m.to === to && m.subject.includes(subjectPart));
    const link = mail ? /https?:\/\/\S+/.exec(mail.text)?.[0] : undefined;
    if (link) return link;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`No email to ${to} with a subject containing "${subjectPart}"`);
}

export async function registerVerifiedUser(page: Page, name: string, email: string): Promise<void> {
  await page.goto("/register");
  await page.locator("#name").fill(name);
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(PASSWORD);
  await page.locator("#confirm").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();

  await page.goto(await waitForLink(email, "Verify your email"));
  await page.getByRole("button", { name: "Verify my email" }).click();
  await expect(page.getByText("Email verified.")).toBeVisible();
}

export async function login(page: Page, email: string, password: string = PASSWORD): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
}
