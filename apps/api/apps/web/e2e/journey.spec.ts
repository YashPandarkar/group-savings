import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { PASSWORD, login, registerVerifiedUser, uniqueEmail, waitForLink } from "./helpers";

type Person = { name: string; email: string; page: Page };

const contexts: BrowserContext[] = [];
test.afterAll(async () => {
  for (const c of contexts) await c.close();
});

// Each person gets their own browser context, so they have their own cookies and session.
async function newPerson(browser: Browser, baseURL: string, name: string): Promise<Person> {
  const context = await browser.newContext({ baseURL });
  contexts.push(context);
  return { name, email: uniqueEmail(name.split(" ")[0].toLowerCase()), page: await context.newPage() };
}

const dashboard = (page: Page) => page.getByRole("heading", { name: "Dashboard" });

test("a group's whole life: join, save, borrow, repay, pay out and correct a mistake", async ({ browser, playwright, baseURL }) => {
  test.setTimeout(240_000);
  const url = baseURL ?? "http://localhost:4100";

  const priya = await newPerson(browser, url, "Priya President");
  const vikram = await newPerson(browser, url, "Vikram Vice");
  const mohan = await newPerson(browser, url, "Mohan Member");
  const meera = await newPerson(browser, url, "Meera Member");

  await test.step("the President registers, logs in and creates a group with 12% flat interest", async () => {
    const p = priya.page;
    await registerVerifiedUser(p, priya.name, priya.email);
    await login(p, priya.email);
    await expect(p.getByRole("heading", { name: /^Welcome, / })).toBeVisible();
    await p.locator("#name").fill("E2E Savings Circle");
    await p.locator("#method").selectOption("FLAT");
    await p.locator("#rate").fill("12");
    await p.getByRole("button", { name: "Create group" }).click();
    await expect(dashboard(p)).toBeVisible();

    // The session survives a reload, and nothing is kept in browser storage.
    await p.reload();
    await expect(dashboard(p)).toBeVisible();
    expect(await p.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
  });

  await test.step("the President invites three people by email", async () => {
    const p = priya.page;
    await p.goto("/members");
    for (const person of [vikram, mohan, meera]) {
      await p.locator("#invite-email").fill(person.email);
      await p.getByRole("button", { name: "Send invitation" }).click();
      await expect(p.getByRole("cell", { name: person.email })).toBeVisible();
    }
  });

  await test.step("they register, verify and accept their invitations", async () => {
    for (const person of [vikram, mohan, meera]) {
      const p = person.page;
      await registerVerifiedUser(p, person.name, person.email);
      await login(p, person.email);
      await expect(p.getByRole("heading", { name: /^Welcome, / })).toBeVisible();
      await p.goto(await waitForLink(person.email, "invited you"));
      await p.getByRole("button", { name: "Accept invitation" }).click();
      await expect(dashboard(p)).toBeVisible();
    }
  });

  await test.step("the President appoints the Vice President", async () => {
    const p = priya.page;
    await p.goto("/members");
    await p.getByRole("row").filter({ hasText: "Vikram" }).getByRole("button", { name: "Make Vice President" }).click();
    await p.getByRole("dialog").getByRole("button", { name: "Make Vice President" }).click();
    await expect(p.getByRole("row").filter({ hasText: "Vikram" }).getByText("Vice President", { exact: true })).toBeVisible();
  });

  await test.step("Mohan pays ₹5,000 online (simulator) and the President records ₹2,000 cash for Meera", async () => {
    const m = mohan.page;
    await m.goto("/deposits");
    await m.locator("#pay-purpose").selectOption("ADDITIONAL_DEPOSIT");
    await m.locator("#pay-amount").fill("5000");
    await m.getByRole("button", { name: "Continue to payment" }).click();
    await expect(m.getByText("Simulated payment (test mode). No real money moves.")).toBeVisible();
    await m.getByRole("button", { name: "Pay successfully" }).click();
    await expect(m.getByText("Your payment was confirmed and recorded.")).toBeVisible();
    await m.getByRole("button", { name: "Close" }).click();
    await expect(m.getByText("Online").first()).toBeVisible();

    const p = priya.page;
    await p.goto("/deposits");
    const option = p.locator("#md-user option", { hasText: "Meera" });
    await expect(option).toHaveCount(1);
    await p.locator("#md-user").selectOption((await option.getAttribute("value")) ?? "");
    await p.locator("#md-purpose").selectOption("ADDITIONAL_DEPOSIT");
    await p.locator("#md-amount").fill("2000");
    await p.locator("#md-note").fill("Cash received at the meeting");
    await p.getByRole("button", { name: "Record deposit" }).click();
    await expect(p.getByText("Deposit recorded.")).toBeVisible();
  });

  await test.step("Meera sees the group's interest policy, then applies for ₹1,000", async () => {
    const p = meera.page;
    await p.goto("/loans/apply");
    await p.locator("#loan-amount").fill("1000");
    await p.locator("#loan-purpose").fill("Shop inventory");
    await p.locator("#loan-count").fill("4");
    await expect(p.getByText(/Flat interest at 12\.00% per year/)).toBeVisible();
    await p.getByRole("button", { name: "Send application" }).click();
    await expect(p.getByRole("heading", { name: /Loan of ₹1,000\.00/ })).toBeVisible();
  });

  await test.step("the Vice President can review the loan but not approve it", async () => {
    const p = vikram.page;
    await p.goto("/loans");
    await p.getByRole("row").filter({ hasText: "Meera" }).getByRole("link", { name: "View" }).click();
    await expect(p.getByText(/Only the President can approve/)).toBeVisible();
    await expect(p.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
    await p.getByRole("button", { name: "Mark under review" }).click();
    await expect(p.getByText("Under review", { exact: true }).first()).toBeVisible();
  });

  await test.step("the President approves it and records the disbursement", async () => {
    const p = priya.page;
    await p.goto("/loans");
    await p.getByRole("row").filter({ hasText: "Meera" }).getByRole("link", { name: "View" }).click();
    await p.getByRole("button", { name: "Approve", exact: true }).click();
    await p.getByRole("dialog").getByRole("button", { name: "Approve", exact: true }).click();
    await expect(p.getByText(/Approved means authorised/)).toBeVisible();

    await p.getByRole("button", { name: "Record disbursement" }).click();
    await p.locator("#dis-method").selectOption("CASH");
    await p.locator("#dis-note").fill("Handed over in cash");
    await p.getByRole("button", { name: "Record disbursement" }).last().click();
    await expect(p.getByText("Disbursed", { exact: true }).first()).toBeVisible();
  });

  await test.step("Meera repays the first installment online", async () => {
    const p = meera.page;
    await p.goto("/loans");
    await p.getByRole("link", { name: "View" }).first().click();
    await p.getByRole("button", { name: "Continue to payment" }).click();
    await p.getByRole("button", { name: "Pay successfully" }).click();
    await expect(p.getByText("Your payment was confirmed and recorded.")).toBeVisible();
    await p.getByRole("button", { name: "Close" }).click();
    await expect(p.getByText("Active", { exact: true }).first()).toBeVisible();
  });

  await test.step("a ₹1,000 payout to Mohan is 'approved, not sent' until the Vice President records the transfer", async () => {
    const p = priya.page;
    await p.goto("/withdrawals");
    await p.getByRole("button", { name: "Request a withdrawal" }).click();
    const option = p.locator("#w-beneficiary option", { hasText: "Mohan" });
    await expect(option).toHaveCount(1);
    await p.locator("#w-beneficiary").selectOption((await option.getAttribute("value")) ?? "");
    await p.locator("#w-amount").fill("1000");
    await p.getByRole("button", { name: "Request withdrawal", exact: true }).click();
    await expect(p.getByText("Approved, not sent").first()).toBeVisible();
    await expect(p.getByText(/NOTHING HAS BEEN SENT/)).toBeVisible();

    const v = vikram.page;
    await v.goto("/withdrawals");
    await v.getByRole("link", { name: "View" }).first().click();
    await v.getByRole("button", { name: "Record the transfer" }).click();
    await v.locator("#wc-method").selectOption("CASH");
    await v.locator("#wc-note").fill("Cash handed over at the meeting");
    await v.getByRole("button", { name: "Record the transfer" }).last().click();
    await expect(v.getByText("Transfer recorded", { exact: true }).first()).toBeVisible();

    const m = mohan.page;
    await m.goto("/withdrawals");
    await expect(m.getByText("Transfer recorded", { exact: true }).first()).toBeVisible();
    await expect(m.getByRole("button", { name: "Request a withdrawal" })).toHaveCount(0);
  });

  await test.step("the President corrects Meera's ₹2,000 deposit by reversing it", async () => {
    const p = priya.page;
    await p.goto("/transactions");
    await p
      .getByRole("row")
      .filter({ hasText: "Meera" })
      .filter({ hasText: "Additional deposit" })
      .getByRole("link", { name: "Details" })
      .click();
    await p.locator("#rev-reason").fill("Recorded against the wrong member");
    await p.getByRole("button", { name: "Reverse this deposit" }).click();
    await p.getByRole("dialog").getByRole("button", { name: "Reverse deposit" }).click();
    await expect(p.getByRole("heading", { name: "Reversal" })).toBeVisible();
  });

  await test.step("after all of that, the books are still consistent", async () => {
    const p = priya.page;
    await p.goto("/reports");
    await p.getByRole("tab", { name: "Books check" }).click();
    await expect(p.getByText(/All checks passed/)).toBeVisible();
  });

  await test.step("a member sees no admin screens, and the server refuses the same actions", async () => {
    const m = mohan.page;
    await m.goto("/");
    await expect(m.getByRole("link", { name: "Reports" })).toHaveCount(0);
    await m.goto("/reports");
    await expect(m.getByText(/Reports are for the President and Vice President/)).toBeVisible();

    // Skip the UI entirely: call the API directly as Mohan.
    const api = await playwright.request.newContext({ baseURL: url });
    const loginRes = await api.post("/api/auth/login", { data: { email: mohan.email, password: PASSWORD } });
    expect(loginRes.ok()).toBe(true);
    const { accessToken } = (await loginRes.json()) as { accessToken: string };
    const headers = { Authorization: `Bearer ${accessToken}` };
    const me = (await (await api.get("/api/auth/me", { headers })).json()) as { membership: { groupId: string } };
    const g = me.membership.groupId;

    expect((await api.get(`/api/groups/${g}/reports/fund`, { headers })).status()).toBe(403);
    expect(
      (await api.post(`/api/groups/${g}/withdrawals`, { headers, data: { kind: "GROUP_EXPENSE", amountPaise: 100, purpose: "Trying to take money" } })).status()
    ).toBe(403);
    expect((await api.put(`/api/groups/${g}`, { headers, data: { name: "Hijacked group" } })).status()).toBe(403);
    await api.dispose();
  });
});
