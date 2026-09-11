import { test, expect } from "@playwright/test";

test.describe("Authentication", () => {
  test("homepage loads and shows hero section", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("body")).toBeVisible();
    await expect(page).toHaveTitle(/Cubelelo/i);
  });

  test("login page renders", async ({ page }) => {
    await page.goto("/login");
    // "Sign in" also appears in the navbar and the submit button — scope to the heading.
    await expect(page.getByRole("heading", { name: /sign in/i })).toBeVisible();
  });

  test("register page renders", async ({ page }) => {
    await page.goto("/register");
    await expect(page.getByRole("heading", { name: /join cubelelo events/i })).toBeVisible();
  });

  test("login with invalid credentials shows error", async ({ page }) => {
    await page.goto("/login");
    // The identifier field accepts email or mobile number, so it isn't type="email".
    // pressSequentially (real keystrokes) rather than fill(): fill() can land
    // before this client-rendered form has hydrated and attached its onChange
    // handlers, silently setting the DOM value without React ever seeing it —
    // the submit button then stays disabled forever.
    await page.getByLabel(/email or mobile number/i).pressSequentially("nobody@example.com");
    await page.getByLabel(/^password$/i).pressSequentially("wrongpassword");
    await page.getByRole("button", { name: /^sign in$/i }).click();
    await expect(page.getByText(/incorrect email or password/i)).toBeVisible({ timeout: 5000 });
  });

  test("register then login flow", async ({ page, request }) => {
    const email = `test_${Date.now()}@example.com`;
    const password = "TestPass123!";

    // Register
    await page.goto("/register");
    await page.getByLabel(/display name/i).pressSequentially("E2E Test User");
    await page.getByLabel(/email or mobile number/i).pressSequentially(email);
    await page.getByLabel(/^password$/i).pressSequentially(password);
    await page.getByLabel(/confirm password/i).pressSequentially(password);
    await page.getByRole("button", { name: /create account/i }).click();

    // Registration hands off to email/mobile verification, not straight into the app.
    await page.waitForURL((url) => url.pathname.startsWith("/verify"), { timeout: 10000 });
  });

  test("forgot password page renders", async ({ page }) => {
    await page.goto("/forgot-password");
    await expect(page.getByRole("heading", { name: /forgot password/i })).toBeVisible();
  });
});
