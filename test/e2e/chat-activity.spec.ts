import type { WebSocketRoute } from "@playwright/test";
import type { ServerMessage, TimelineEvent } from "../../src/shared/protocol";
import { test, expect } from "./fixtures";

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`tool actions and failures are readable at ${viewport.width}px`, async ({
    page,
    racco,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    const session = racco.sessions[0]!;
    let socket: WebSocketRoute | undefined;
    await page.routeWebSocket("**/api/ws", (route) => {
      socket = route;
      route.connectToServer();
    });
    const emit = (event: TimelineEvent) =>
      socket!.send(
        JSON.stringify({
          type: "timeline.event",
          session: { sessionId: session.sessionId },
          event,
        } satisfies ServerMessage),
      );
    await page.goto(`/session/${session.sessionId}`);
    await expect(page.locator(".tool-card")).toBeVisible();
    emit({
      type: "assistant.message",
      id: "investigation",
      text: "正在核对工具展示与执行结果。",
      phase: "commentary",
    });
    for (let i = 1; i <= 5; i++) {
      emit({
        type: "tool.started",
        id: `read-${i}`,
        tool: "Read",
        input: { file_path: `src/component-${i}.tsx` },
      });
      emit({ type: "tool.completed", id: `read-${i}`, status: "completed" });
    }
    emit({
      type: "tool.started",
      id: "test-failure",
      tool: "Bash",
      input: { command: "npm test", description: "验证组件行为" },
    });
    emit({
      type: "tool.completed",
      id: "test-failure",
      status: "failed",
      output:
        "FAIL ToolGroup: expected visible command summary\n1 assertion failed",
    });
    emit({
      type: "tool.started",
      id: "build-running",
      tool: "Bash",
      input: { command: "npm run build", description: "构建前端" },
    });
    emit({
      type: "tool.output",
      id: "build-running",
      output: "transforming modules...\nrendering chunks...",
    });
    await expect(
      page.locator('[data-timeline-row="test-failure"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-timeline-row="test-failure"]'),
    ).toContainText("FAIL ToolGroup");
    await expect(
      page.locator('[data-timeline-row="build-running"]'),
    ).toContainText("构建前端");
    await expect(
      page.locator('[data-timeline-row="build-running"]'),
    ).toContainText("rendering chunks");
    await expect(page.locator('[data-timeline-row="read-1"]')).toBeHidden();
    await page.locator(".tool-history > summary").click();
    await expect(page.locator('[data-timeline-row="read-1"]')).toBeVisible();
    await page.locator(".tool-history > summary").click();
    await page.screenshot({
      path: testInfo.outputPath(`chat-${viewport.width}.png`),
    });
    await page.locator('[data-timeline-row="test-failure"]').click();
    const inspector = page.getByRole("complementary", { name: "工具详情" });
    await expect(
      inspector.getByRole("tab", { name: "Output", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(inspector).toContainText("FAIL ToolGroup");
  });
}
