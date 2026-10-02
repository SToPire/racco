import { test, expect } from "./fixtures";

for (const width of [390, 1440]) {
  test(`detail panels use modal focus only when overlaying at ${width}px`, async ({
    page,
    racco,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`/session/${racco.sessions[0]!.sessionId}`);
    const tool = page.locator(".tool-card").first();
    await tool.focus();
    await page.keyboard.press("Enter");
    const inspector = page.getByRole(
      width === 390 ? "dialog" : "complementary",
      { name: "工具详情", exact: true },
    );
    await expect(inspector).toBeVisible();
    if (width === 390) {
      for (let i = 0; i < 12; i++) {
        await page.keyboard.press(i % 2 ? "Shift+Tab" : "Tab");
        expect(
          await inspector.evaluate((element) =>
            element.contains(document.activeElement),
          ),
        ).toBe(true);
      }
    } else {
      await page.getByRole("textbox", { name: "发送给 Racco" }).focus();
      await expect(
        page.getByRole("textbox", { name: "发送给 Racco" }),
      ).toBeFocused();
      await inspector.getByRole("button", { name: "关闭工具详情" }).focus();
    }
    await page.keyboard.press("Escape");
    await expect(inspector).toHaveCount(0);
    if (width === 390) await expect(tool).toBeFocused();
    const launcher = page.getByRole("button", { name: "展开文件侧栏" });
    await launcher.focus();
    await page.keyboard.press("Enter");
    const dock = page.getByRole(width === 390 ? "dialog" : "complementary", {
      name: "文件侧栏",
      exact: true,
    });
    await expect(dock).toBeVisible();
    if (width === 390) {
      await page.keyboard.press("Shift+Tab");
      expect(
        await dock.evaluate((element) =>
          element.contains(document.activeElement),
        ),
      ).toBe(true);
    }
    await dock.getByRole("button", { name: "折叠文件侧栏" }).focus();
    await page.keyboard.press("Escape");
    await expect(launcher).toBeFocused();
    await page.getByRole("button", { name: "Trajectory", exact: true }).click();
    const row = page.locator(".trajectory-entry").first();
    await row.focus();
    await page.keyboard.press("Enter");
    const trajectory = page.getByRole(
      width === 390 ? "dialog" : "complementary",
      { name: "交互详情", exact: true },
    );
    await expect(trajectory).toBeVisible();
    await trajectory.getByRole("button", { name: "关闭交互详情" }).focus();
    await page.keyboard.press("Escape");
    await expect(trajectory).toHaveCount(0);
    if (width === 390) await expect(row).toBeFocused();
  });
}

test("browser back closes cached trajectory dialogs and project overlays", async ({
  page,
  racco,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "返回对话历史" }).click();
  const session = page
    .locator(".history-row")
    .filter({ hasText: racco.sessions[0]!.title! });
  await session.click();
  await page.getByRole("button", { name: "Trajectory", exact: true }).click();
  await page.locator(".trajectory-entry").first().click();
  await expect(page.getByRole("dialog", { name: "交互详情" })).toBeVisible();
  await page.goBack();
  await expect(page.locator("dialog:modal")).toHaveCount(0);
  await session.click();
  await expect(page.locator("dialog:modal")).toHaveCount(0);
  await page.getByRole("button", { name: "展开文件侧栏" }).click();
  await expect(page.getByRole("dialog", { name: "文件侧栏" })).toBeVisible();
  await page.goBack();
  await expect(page.locator("dialog:modal")).toHaveCount(0);
});

test("an open dock changes from mobile modal to desktop resizing without retaining a stale panel", async ({
  page,
  racco,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/session/${racco.sessions[0]!.sessionId}`);
  await page.getByRole("button", { name: "展开文件侧栏" }).click();
  await expect(page.getByRole("dialog", { name: "文件侧栏" })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  const dock = page.getByRole("complementary", { name: "文件侧栏" });
  await expect(dock).toBeVisible();
  await expect(page.locator("dialog:modal")).toHaveCount(0);
  const resizer = dock.getByRole("separator", { name: "调整文件侧栏宽度" });
  await resizer.focus();
  await page.keyboard.press("End");
  await expect
    .poll(async () => Number(await resizer.getAttribute("aria-valuemax")))
    .toBe(1088);
  await expect.poll(async () => (await dock.boundingBox())?.width).toBe(1088);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("dialog", { name: "文件侧栏" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "展开文件侧栏" }),
  ).toBeFocused();
});

test("session dock preserves provider, filter and focus across layout modes", async ({
  page,
  racco,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/session/${racco.sessions[0]!.sessionId}`);
  const launcher = page.getByRole("button", { name: "展开会话侧栏" });
  await launcher.click();
  const desktop = page.getByRole("complementary", { name: "会话侧栏" });
  await desktop.getByRole("button", { name: "Claude", exact: true }).click();
  const filter = page.getByRole("searchbox", { name: "筛选已加载会话" });
  await filter.fill("Alpha");
  await expect(filter).toBeFocused();

  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const panel = page.getByRole(width === 390 ? "dialog" : "complementary", {
      name: "会话侧栏",
    });
    await expect(panel).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "Claude", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(filter).toHaveValue("Alpha");
    await expect(filter).toBeFocused();
    await expect(page.locator("dialog:modal")).toHaveCount(
      width === 390 ? 1 : 0,
    );
  }
  await page.keyboard.press("Escape");
  await expect(launcher).toBeFocused();
});
