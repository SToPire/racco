import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./test/e2e",
  globalSetup: "./test/e2e/global-setup.mjs",
  fullyParallel: true,
  workers: 2,
  timeout: 30_000,
  reporter: [
    ["list"],
    ["json", { outputFile: ".tmp/check/playwright.json" }],
    ["html", { outputFolder: ".tmp/playwright-report", open: "never" }],
  ],
  outputDir: ".tmp/playwright-results",
  use: {
    browserName: "chromium",
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
