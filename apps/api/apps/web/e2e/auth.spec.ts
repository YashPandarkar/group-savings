import { expect, test } from "@playwright/test";
import { PASSWORD, login, registerVerifiedUser, uniqueEmail, waitForLink } from "./helpers";

test("pages that need a login send a visitor to the login page", async ({ page }) => {
  await page.goto("/loans");
  await expect(page).toHaveURL(/\/login/);
});

test("a wrong password is refused with a clear message", async ({ page }) => {
  const email = uniqueEmail("wrongpw");
  await registerVerifiedUser(page, "Wrong Password", email);
  await login(page, email, "NotThePassword1");
  await expect(page.getByText("Incorrect email or password.")).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
});

test("forgot password: the emailed link sets a new password and the old one stops working", async ({ page }) => {
  const email = uniqueEmail("reset");
  await registerVerifiedUser(page, "Reset Person", email);

  await page.goto("/forgot-password");
  await page.locator("#email").fill(email);
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByText(/sent a reset link/)).toBeVisible();

  await page.goto(await waitForLink(email, "Reset your password"));
  await page.locator("#password").fill("BrandNewPass77");
  await page.locator("#confirm").fill("BrandNewPass77");
  await page.getByRole("button", { name: "Update password" }).click();
  await expect(page.getByText(/Password updated/)).toBeVisible();

  await login(page, email, PASSWORD);
  await expect(page.getByText("Incorrect email or password.")).toBeVisible();
  await login(page, email, "BrandNewPass77");
  await expect(page.getByRole("heading", { name: /^Welcome, / })).toBeVisible();
});
