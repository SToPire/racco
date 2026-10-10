import type { Page, WebSocketRoute } from "@playwright/test";
import type { ServerMessage } from "../../src/shared/protocol";
import { test, expect } from "./fixtures";

async function selectModel(page: Page) {
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await page.getByRole("option", { name: /Fixture Primary/ }).click();
}

for (const [index, width] of [
  [0, 1440],
  [1, 390],
] as const) {
  test(`request time survives views, navigation, refresh and another client at ${width}px`, async ({
    page,
    context,
    racco,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const session = racco.sessions[index];
    await page.goto(`/session/${session.sessionId}`);
    await selectModel(page);
    const input = page.getByRole("textbox", { name: "发送给 Racco" });
    await input.fill("wait");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const timer = page.getByRole("timer", { name: "当前请求耗时" });
    await expect(timer).toBeVisible();
    await expect(timer).toHaveAttribute("aria-live", "off");
    await expect(timer).not.toContainText("00:00");
    await input.fill("draft while waiting");
    await page.getByRole("button", { name: "Trajectory", exact: true }).click();
    await expect(timer).toBeVisible();
    await expect(timer).not.toContainText("00:00");
    await page.getByRole("button", { name: "Chat", exact: true }).click();

    if (width < 760)
      await page.getByRole("button", { name: "返回对话历史" }).click();
    await page
      .locator(".history-row")
      .filter({ hasText: racco.sessions[1 - index].title! })
      .click();
    if (width < 760)
      await page.getByRole("button", { name: "返回对话历史" }).click();
    await page
      .locator(".history-row")
      .filter({ hasText: session.title! })
      .click();
    await expect(timer).not.toContainText("00:00");
    await expect(input).toHaveValue("draft while waiting");
    await page.screenshot({ path: testInfo.outputPath(`timer-${width}.png`) });
    const stop = page.getByRole("button", { name: "停止生成", exact: true });
    await expect(stop).toBeInViewport();
    await expect(timer).toBeInViewport();
    expect(
      await page
        .locator(".request-controls:visible")
        .evaluate((element) => element.scrollWidth - element.clientWidth),
    ).toBeLessThanOrEqual(1);

    await page.reload();
    await expect(timer).toBeVisible();
    await expect(timer).not.toContainText("00:00");
    const other = await context.newPage();
    await other.goto(`/session/${session.sessionId}`);
    await expect(other.getByRole("timer")).toBeVisible();
    await expect(other.getByRole("timer")).not.toContainText("00:00");
    await stop.click();
    await expect(timer).toHaveCount(0);
    await expect(other.getByRole("timer")).toHaveCount(0);
    await other.close();

    await selectModel(page);
    await input.fill("question");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.locator(".request-timer:visible")).toContainText(
      "等待你回答",
    );
    await expect(timer).not.toContainText("00:00");
    await page.getByRole("radio", { name: "Alpha", exact: true }).check();
    await page.getByRole("button", { name: "提交回答", exact: true }).click();
    await expect(timer).toHaveCount(0);
    await input.fill("error");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.locator(".run-state:visible")).toHaveText("出错");
    await expect(timer).toHaveCount(0);
  });
}

test("timer catches up after hidden time, ignores wall-clock changes, and waits for fresh state on reconnect", async ({
  page,
  racco,
}) => {
  let socket!: WebSocketRoute;
  let holdSync = false;
  await page.routeWebSocket("**/api/ws", (route) => {
    socket = route;
    const server = route.connectToServer();
    server.onMessage((message) => {
      const data = JSON.parse(String(message)) as ServerMessage;
      if (
        holdSync &&
        (data.type === "session.snapshot" || data.type === "session.upserted")
      )
        return;
      route.send(message);
    });
  });
  const session = racco.sessions[0];
  await page.clock.install();
  await page.goto(`/session/${session.sessionId}`);
  await expect(page.locator(".conversation")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  const emit = (message: ServerMessage) => socket.send(JSON.stringify(message));
  const running = {
    ...session,
    state: "running" as const,
    activeRequest: { id: "first", elapsedMs: 12000 },
  };
  emit({ type: "session.upserted", session: running });
  const timer = page.getByRole("timer");
  await expect(timer).toContainText("00:12");
  await page.clock.runFor(5000);
  await expect(timer).toContainText("00:17");
  await page.clock.setSystemTime(new Date("2040-01-01T00:00:00Z"));
  await expect(timer).toContainText("00:17");
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.runFor(60000);
  await expect(timer).toContainText("00:17");
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(timer).toContainText("01:17");
  emit({
    type: "session.upserted",
    session: {
      ...running,
      state: "waiting_interaction",
      activeRequest: { id: "first", elapsedMs: 75000 },
    },
  });
  await expect(page.locator(".request-timer")).toContainText("等待你回答");
  await expect(timer).toContainText("01:17");
  emit({
    type: "timeline.event",
    session,
    event: {
      type: "subagent.started",
      id: "child",
      agentId: "child",
      name: "Timer worker",
    },
  });
  await page.locator(".agent-switcher-trigger").click();
  await page.getByRole("option").filter({ hasText: "Timer worker" }).click();
  await expect(page.locator(".request-timer")).toContainText("Main Agent");

  let releaseCatalog!: () => void;
  let catalogPending = false;
  const catalogGate = new Promise<void>((resolve) => {
    releaseCatalog = resolve;
  });
  await page.route("**/api/sessions", async (route) => {
    catalogPending = true;
    await catalogGate;
    await route.fulfill({ json: [running, racco.sessions[1]] });
  });
  holdSync = true;
  socket.close();
  await expect(page.locator(".request-timer")).toContainText("连接中断");
  await expect(timer).toHaveText("最后确认用时 01:15");
  await page.clock.runFor(500);
  await expect.poll(() => catalogPending).toBe(true);
  await expect(page.locator(".request-timer")).toContainText("正在同步");
  await page.clock.runFor(5000);
  await expect(timer).toHaveText("最后确认用时 01:15");
  emit({
    type: "session.upserted",
    session: { ...running, activeRequest: { id: "second", elapsedMs: 0 } },
  });
  await expect(timer).toHaveText("请求已用时 00:00");
  await page.clock.runFor(1000);
  await expect(timer).toHaveText("请求已用时 00:01");
  emit({
    type: "session.upserted",
    session: { ...session, activeRequest: null },
  });
  await expect(timer).toHaveCount(0);
  const loaded = page.waitForResponse("**/api/sessions");
  releaseCatalog();
  await loaded;
  await page.clock.runFor(1000);
  await expect(timer).toHaveCount(0);
  await expect(page.locator(".run-state")).toHaveText("空闲");
});

test("a new session's first request gets the same timer", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "项目", exact: true }).click();
  await page.getByRole("option", { name: "alpha", exact: true }).click();
  await selectModel(page);
  await page.getByRole("textbox", { name: "首条任务" }).fill("wait");
  await page.getByRole("button", { name: "新建并发送", exact: true }).click();
  await expect(page).toHaveURL(/\/session\//);
  await expect(page.getByRole("timer")).toBeVisible();
  await expect(page.getByRole("timer")).not.toContainText("00:00");
  await page.getByRole("button", { name: "停止生成", exact: true }).click();
  await expect(page.getByRole("timer")).toHaveCount(0);
});
