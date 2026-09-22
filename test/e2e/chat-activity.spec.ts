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
    const modelOutput =
      "FAIL ToolGroup: expected visible command summary\n1 assertion failed";
    emit({
      type: "tool.completed",
      id: "test-failure",
      status: "failed",
      output: modelOutput,
      details: {
        type: "claudeToolResult",
        result: {
          stdout: "Native stdout omitted from model output",
          stderr: "Native stderr omitted from model output",
          interrupted: false,
        },
        content: modelOutput,
      },
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
    const read = page.locator('[data-timeline-row="read-1"]');
    await expect(read).toBeVisible();
    await expect(read).toContainText("src/component-1.tsx");
    await expect
      .poll(async () => (await read.boundingBox())?.height ?? Infinity)
      .toBeLessThanOrEqual(34);
    await expect
      .poll(
        async () =>
          (
            await page
              .locator('[data-timeline-row="test-failure"]')
              .boundingBox()
          )?.height ?? Infinity,
      )
      .toBeLessThanOrEqual(68);
    await page.screenshot({
      path: testInfo.outputPath(`chat-expanded-${viewport.width}.png`),
    });
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
    await expect(inspector.locator("[data-tool-output]")).toHaveCount(1);
    await expect(inspector).not.toContainText("Native stdout");
    await expect(inspector).not.toContainText("Native stderr");
    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"]);
    await inspector.getByRole("button", { name: "复制输出" }).click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(modelOutput);
    await page.getByRole("button", { name: "关闭工具详情" }).click();
    emit({
      type: "subagent.started",
      id: "worker",
      agentId: "worker",
      name: "Worker",
      prompt: "检查远程工具",
    });
    emit({
      type: "subagent.event",
      id: "worker-tool",
      agentId: "worker",
      event: {
        type: "tool.started",
        id: "long-tool",
        tool: "mcp__google_drive__batch_update_document",
        input: { description: "更新项目说明" },
      },
    });
    await page.getByRole("button", { name: "查看 Worker 的对话" }).click();
    const childTool = page.locator(".trajectory-tool-row");
    await expect(childTool).toContainText("更新项目说明");
    await expect
      .poll(
        async () =>
          (await childTool.locator("strong").boundingBox())?.width ?? Infinity,
      )
      .toBeLessThanOrEqual(96);
    await expect
      .poll(() =>
        page
          .locator(".conversation")
          .evaluate((element) => element.scrollWidth - element.clientWidth),
      )
      .toBeLessThanOrEqual(1);
  });
}
