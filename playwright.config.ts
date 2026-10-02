import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./test/e2e",
  globalSetup: "./test/e2e/global-setup.mjs",
  fullyParallel: true,
  forbidOnly: process.env.RACCO_FULL_CHECK === "1",
  workers: 2,
  timeout: 30_000,
  reporter: [
    ["list"],
    ["json", { outputFile: ".tmp/check/playwright.json" }],
    ["html", { outputFolder: ".tmp/playwright-report", open: "never" }],
  ],
  projects: [
    { name: "desktop", testIgnore: /touch-workflows\.spec\.ts/ },
    {
      name: "touch",
      testMatch: /touch-workflows\.spec\.ts/,
      use: { ...devices["Pixel 7"] },
    },
  ],
  outputDir: ".tmp/playwright-results",
  use: {
    browserName: "chromium",
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
