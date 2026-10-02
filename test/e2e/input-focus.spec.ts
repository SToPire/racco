import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures";

async function expectKeyboardOutline(page: Page, input: Locator) {
  await input.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(input).toBeFocused();
  const outline = await input.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      style: style.outlineStyle,
      width: parseFloat(style.outlineWidth),
      color: style.outlineColor,
    };
  });
  expect(outline.style).not.toBe("none");
  expect(outline.width).toBeGreaterThan(0);
  expect(outline.color).not.toBe("rgba(0, 0, 0, 0)");
}

for (const theme of ["light", "dark"] as const) {
  test(`${theme} message and search inputs keep a visible keyboard focus`, async ({
    page,
    racco,
  }) => {
    await page.goto("/");
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    await expectKeyboardOutline(
      page,
      page.getByRole("textbox", { name: "首条任务" }),
    );
    await page.goto(`/session/${racco.sessions[0].sessionId}`);
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    await expectKeyboardOutline(
      page,
      page.getByRole("textbox", { name: "发送给 Racco" }),
    );
    await page.getByRole("button", { name: "Trajectory", exact: true }).click();
    await expectKeyboardOutline(
      page,
      page.getByRole("searchbox", { name: "搜索交互" }),
    );
  });
}
