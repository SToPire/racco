import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { chromium } from "playwright";
import { previewStatus } from "./preview.mjs";
const url = process.env.RACCO_URL ?? (await previewStatus()).url;
const output = resolve(process.env.RACCO_SCREENSHOT ?? ".tmp/ui-preview.png");
await mkdir(dirname(output), { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  await page.goto(url);
  await page.getByRole("navigation", { name: "项目与对话" }).waitFor();
  await page.screenshot({ path: output });
  console.log(JSON.stringify({ url, output }));
} finally {
  await browser.close();
}
