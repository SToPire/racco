import { test, expect } from "./fixtures";

for (const view of ["home", "session"] as const) {
  test(`${view} input grows for pasted paragraphs, scrolls at its limit and shrinks when cleared`, async ({
    page,
    racco,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(
      view === "home" ? "/" : `/session/${racco.sessions[0].sessionId}`,
    );
    const input = page.getByRole("textbox", {
      name: view === "home" ? "首条任务" : "发送给 Racco",
    });
    await expect(input).toBeVisible();
    const initialHeight = await input.evaluate(
      (element) => element.getBoundingClientRect().height,
    );
    const paragraphs = Array.from(
      { length: 24 },
      (_, index) => `Paragraph ${index}`,
    ).join("\n");
    await input.fill(paragraphs);
    await expect
      .poll(() =>
        input.evaluate((element) => element.getBoundingClientRect().height),
      )
      .toBeGreaterThan(initialHeight);
    const metrics = await input.evaluate((element) => ({
      height: element.getBoundingClientRect().height,
      limit: Number.parseFloat(getComputedStyle(element).maxHeight),
      client: element.clientHeight,
      scroll: element.scrollHeight,
    }));
    expect(metrics.height).toBeLessThanOrEqual(metrics.limit + 1);
    expect(metrics.scroll).toBeGreaterThan(metrics.client);
    await input.fill("");
    await expect
      .poll(() =>
        input.evaluate((element) => element.getBoundingClientRect().height),
      )
      .toBeCloseTo(initialHeight, 0);
  });
}

test("a session draft reflows on viewport changes and restores its height after being hidden", async ({
  page,
  racco,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/session/${racco.sessions[0].sessionId}`);
  const input = page.getByRole("textbox", { name: "发送给 Racco" });
  const text = "wrapping words ".repeat(15);
  await input.fill(text);
  const wideHeight = await input.evaluate(
    (element) => element.getBoundingClientRect().height,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      input.evaluate((element) => element.getBoundingClientRect().height),
    )
    .toBeGreaterThan(wideHeight);
  const narrowHeight = await input.evaluate(
    (element) => element.getBoundingClientRect().height,
  );
  await page.getByRole("button", { name: "返回对话历史" }).click();
  await page
    .locator(".history-row")
    .filter({ hasText: racco.sessions[1].title! })
    .click();
  await page.getByRole("button", { name: "返回对话历史" }).click();
  await page
    .locator(".history-row")
    .filter({ hasText: racco.sessions[0].title! })
    .click();
  await expect(input).toHaveValue(text);
  await expect
    .poll(() =>
      input.evaluate((element) => element.getBoundingClientRect().height),
    )
    .toBeCloseTo(narrowHeight, 0);
});
