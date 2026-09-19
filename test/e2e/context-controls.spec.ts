import { test, expect } from "./fixtures";

test("Codex shows context usage and compacts without submitting or losing the draft", async ({
  page,
  context,
  racco,
}, testInfo) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto(`/session/${racco.sessions[0].sessionId}`);
  const usage = page.getByLabel("主会话上下文", { exact: true });
  await expect(usage).toContainText("未知 / 未知");
  const composer = page.getByRole("textbox", { name: "发送给 Racco" });
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await page.getByRole("option", { name: /Fixture Primary/ }).click();
  await composer.fill("observe-context");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(
    page.getByText("Fixture: observe-context", { exact: true }),
  ).toBeVisible();
  await expect(usage).toContainText("81,920 / 272,000");
  await composer.fill("preserve this draft");
  await page.screenshot({ path: testInfo.outputPath("context-mobile.png") });
  const other = await context.newPage();
  await other.goto(page.url());
  const compact = page.getByRole("button", { name: "压缩上下文", exact: true });
  const box = await compact.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(360);
  await compact.click();
  const busyButton = page.getByRole("button", {
    name: "正在压缩…",
    exact: true,
  });
  await expect(busyButton).toBeDisabled();
  await expect(busyButton).toHaveAttribute("aria-busy", "true");
  await expect(composer).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "模型", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "发送", exact: true }),
  ).toBeDisabled();
  await expect(page.locator(".composer")).toHaveClass(/composer-compacting/);
  await expect(page.locator(".run-state")).toHaveText("压缩中");
  await expect(page.getByText(/压缩请求已发送/)).toHaveCount(0);
  await expect(
    other.getByRole("textbox", { name: "发送给 Racco" }),
  ).toBeDisabled();
  await other.reload();
  await expect(
    other.getByRole("button", { name: "正在压缩…", exact: true }),
  ).toBeDisabled();
  await page.screenshot({
    path: testInfo.outputPath("context-compacting.png"),
  });
  await expect(page.getByText("上下文已压缩", { exact: true })).toBeVisible();
  await expect(usage).toContainText("12,000 / 272,000");
  await expect(composer).toHaveValue("preserve this draft");
  await expect(composer).toBeEnabled();
  await expect(compact).toBeEnabled();
  await expect(
    other.getByRole("textbox", { name: "发送给 Racco" }),
  ).toBeEnabled();
  await expect(other.getByLabel("主会话上下文", { exact: true })).toContainText(
    "12,000 / 272,000",
  );
  const snapshot = await (
    await page.request.get(`/api/sessions/${racco.sessions[0].sessionId}`)
  ).json();
  expect(
    snapshot.events.filter(
      (event: { type: string }) => event.type === "user.message",
    ),
  ).toHaveLength(2);
  await page.reload();
  await expect(usage).toContainText("12,000 / 272,000");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: testInfo.outputPath("context-desktop.png") });
  await page.goto(`/session/${racco.sessions[1].sessionId}`);
  await expect(
    page.getByRole("button", { name: "压缩上下文", exact: true }),
  ).toHaveCount(0);
  await expect(usage).toHaveCount(0);
});

test("compact without a model choice disables input until native completion", async ({
  page,
  racco,
}) => {
  await page.goto(`/session/${racco.sessions[0].sessionId}`);
  await page.getByRole("button", { name: "压缩上下文", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "正在压缩…", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("textbox", { name: "发送给 Racco" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "停止生成", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("上下文已压缩", { exact: true })).toBeVisible();
  const snapshot = await (
    await page.request.get(`/api/sessions/${racco.sessions[0].sessionId}`)
  ).json();
  expect(snapshot.session.selectedModelSettings).toBeNull();
});

test("failed compaction reports the failure and restores controls", async ({
  page,
  racco,
}) => {
  await page.goto(`/session/${racco.sessions[0].sessionId}`);
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await page.getByRole("option", { name: /Fixture Primary/ }).click();
  await page
    .getByRole("textbox", { name: "发送给 Racco" })
    .fill("compact-error");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(
    page.getByText("Fixture: compact-error", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "压缩上下文", exact: true }).click();
  await expect(
    page.getByText("Fixture compaction failed", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".run-state")).toHaveText("空闲");
  await expect(
    page.getByRole("button", { name: "压缩上下文", exact: true }),
  ).toBeEnabled();
  await expect(page.getByLabel("主会话上下文", { exact: true })).toContainText(
    "81,920 / 272,000",
  );
});

test("an asynchronous compaction failure unlocks the composer and preserves the draft", async ({
  page,
  racco,
}) => {
  await page.goto(`/session/${racco.sessions[0].sessionId}`);
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await page.getByRole("option", { name: /Fixture Primary/ }).click();
  const input = page.getByRole("textbox", { name: "发送给 Racco" });
  await input.fill("compact-async-error");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(
    page.getByText("Fixture: compact-async-error", { exact: true }),
  ).toBeVisible();
  await input.fill("keep this draft");
  await page.getByRole("button", { name: "压缩上下文", exact: true }).click();
  await expect(input).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "正在压缩…", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText("Fixture asynchronous compaction failed", { exact: true }),
  ).toBeVisible();
  await expect(input).toBeEnabled();
  await expect(input).toHaveValue("keep this draft");
  await expect(
    page.getByRole("button", { name: "压缩上下文", exact: true }),
  ).toBeEnabled();
});
