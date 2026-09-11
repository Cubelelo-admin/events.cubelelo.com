import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: "html",
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      // `VAR="" command` is POSIX-only shell syntax — Playwright spawns this
      // through cmd.exe on Windows, where it fails with "'DATABASE_URL' is
      // not recognized...", so nothing ever listens on :4000 and the whole
      // suite errors out unless a server happens to already be running.
      // `env` is Playwright's own cross-platform way to set it instead.
      command: "cd apps/api && npx tsx src/server.ts",
      env: { DATABASE_URL: "" },
      port: 4000,
      reuseExistingServer: !process.env.CI,
      timeout: 30000,
    },
    {
      command: "cd apps/web && npx next dev -p 3000",
      port: 3000,
      reuseExistingServer: !process.env.CI,
      timeout: 30000,
    },
  ],
});
