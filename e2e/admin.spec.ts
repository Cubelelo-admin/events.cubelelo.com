import { test, expect, type Page } from "@playwright/test";
import { SignJWT } from "jose";
import { randomUUID } from "node:crypto";

// There is no dev-login endpoint anymore — it was removed in the security
// hardening pass (see apps/api/test/helpers.ts). Mint the same HS256 token
// the integration tests mint: signed with DEV_AUTH_SECRET (the "dev-secret-
// change-me" default, since the Playwright webServer boots the API with no
// overrides), `sub` set to the seeded admin's fixed id.
const SEED_ADMIN_EMAIL = "admin@cubelelo.com";
const SEED_ADMIN_ID = "00000000-0000-0000-0000-0000000000ad";
const DEV_AUTH_SECRET = process.env.DEV_AUTH_SECRET ?? "dev-secret-change-me";

async function devLogin(page: Page): Promise<void> {
  const secret = new TextEncoder().encode(DEV_AUTH_SECRET);
  const token = await new SignJWT({ email: SEED_ADMIN_EMAIL, name: "Admin" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(SEED_ADMIN_ID)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(secret);

  await page.goto("/");
  await page.evaluate((t) => {
    localStorage.setItem("cubers_token", t);
  }, token);
  await page.reload();
}

test.describe("Admin Panel", () => {
  test.beforeEach(async ({ page }) => {
    await devLogin(page);
  });

  test("admin dashboard loads", async ({ page }) => {
    await page.goto("/admin");
    await expect(page.locator("body")).toBeVisible();
  });

  test("admin users page loads", async ({ page }) => {
    await page.goto("/admin/users");
    // The nav link, the page heading and (once there are any) row content all
    // match /users/i too — scope to the heading, the one thing guaranteed
    // unique regardless of seed data.
    await expect(page.getByRole("heading", { name: /^users$/i })).toBeVisible();
  });

  test("admin announcements page loads", async ({ page }) => {
    await page.goto("/admin/announcements");
    await expect(page.getByRole("heading", { name: /^announcements$/i })).toBeVisible();
  });

  // /admin/content is the footer content-pages editor (About Us, Rules,
  // Privacy Policy, ...) — banners live under /admin/announcements instead.
  test("admin content (pages) page loads", async ({ page }) => {
    await page.goto("/admin/content");
    await expect(page.getByText(/footer pages/i)).toBeVisible();
  });

  test("admin FAQ page loads", async ({ page }) => {
    await page.goto("/admin/faq");
    await expect(page.getByRole("heading", { name: /^faqs$/i })).toBeVisible();
  });

  test("admin staff page loads", async ({ page }) => {
    await page.goto("/admin/staff");
    await expect(page.getByRole("heading", { name: /^staff management$/i })).toBeVisible();
  });

  test("create and delete a banner", async ({ page }) => {
    await page.goto("/admin/announcements");
    await page.getByRole("button", { name: /new announcement/i }).click();
    await page.fill('input[placeholder*="title" i]', "E2E Test Banner");
    await page.getByRole("button", { name: /^create$/i }).click();

    await expect(page.getByText("E2E Test Banner")).toBeVisible({ timeout: 5000 });

    // Deletion goes through a confirm dialog (a real modal, not window.confirm),
    // so the "Delete" button is ambiguous until scoped to it.
    await page.getByRole("button", { name: /^delete$/i }).click();
    const confirmDialog = page.getByRole("dialog", { name: /delete announcement/i });
    await confirmDialog.getByRole("button", { name: /^delete$/i }).click();
    await expect(page.getByText("E2E Test Banner")).not.toBeVisible({ timeout: 5000 });
  });

  test("create and delete an FAQ entry", async ({ page }) => {
    await page.goto("/admin/faq");
    await page.getByRole("button", { name: /new faq/i }).click();
    await page.fill('input[placeholder*="how" i]', "E2E Test Question?");
    await page.fill('textarea', "E2E Test Answer in **markdown**.");
    await page.getByRole("button", { name: /^create$/i }).click();

    await expect(page.getByText("E2E Test Question?")).toBeVisible({ timeout: 5000 });

    await page.getByRole("button", { name: /^delete$/i }).click();
    const confirmDialog = page.getByRole("dialog", { name: /delete faq/i });
    await confirmDialog.getByRole("button", { name: /^delete$/i }).click();
    await expect(page.getByText("E2E Test Question?")).not.toBeVisible({ timeout: 5000 });
  });
});
