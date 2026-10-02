import type { WebSocketRoute } from "@playwright/test";
import type {
  AgentTimelineEvent,
  ServerMessage,
  TimelineEvent,
} from "../../src/shared/protocol";
import { test, expect } from "./fixtures";

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`tool history stays chronological through selection and status updates at ${viewport.width}px`, async ({
    page,
    racco,
  }) => {
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
      id: "history-intro",
      text: "检查工具调用的时间线顺序。",
    });
    const calls = [
      ["history-a", "failed"],
      ["history-b", "completed"],
      ["history-c", "running"],
      ["history-d", "running"],
      ["history-e", "completed"],
      ["history-f", "completed"],
    ] as const;
    for (const [id, status] of calls) {
      emit({
        type: "tool.started",
        id,
        tool: "command",
        input: { command: `run-${id}` },
        details: {
          type: "commandExecution",
          id,
          command: `run-${id}`,
          cwd: session.cwd,
          commandActions: [],
        },
      });
      if (status !== "running") {
        emit({ type: "tool.completed", id, status });
      }
    }
    const ids = calls.map(([id]) => id);
    const group = page.locator(".tool-group").filter({
      has: page.locator('[data-timeline-row="history-a"]'),
    });
    const history = group.locator(".tool-history");
    const row = (id: string) => group.locator(`[data-timeline-row="${id}"]`);
    const expectOrder = async () => {
      await expect
        .poll(() =>
          group
            .locator(".tool-card")
            .evaluateAll((rows) =>
              rows.map((element) => element.getAttribute("data-timeline-row")),
            ),
        )
        .toEqual(ids);
      await expect(history.locator(".tool-card")).toHaveCount(4);
      await expect(
        group.locator(":scope > .tool-group-items > .tool-card"),
      ).toHaveCount(2);
      await expect(history.locator("summary")).toHaveText(
        "较早 4 项 · command 4",
      );
    };
    await expectOrder();
    for (const id of ids.slice(0, 4)) await expect(row(id)).toBeHidden();
    for (const id of ids.slice(4)) await expect(row(id)).toBeVisible();

    await history.locator("summary").click();
    for (const id of ids) await expect(row(id)).toBeVisible();
    await expectOrder();
    await row("history-b").click();
    const inspector = page.getByRole(
      viewport.width <= 1100 ? "dialog" : "complementary",
      { name: "工具详情" },
    );
    await expect(inspector).toBeVisible();
    await expect(row("history-b")).toHaveAttribute("aria-pressed", "true");
    await expect(
      history.locator('[data-timeline-row="history-b"]'),
    ).toBeVisible();
    await expect(history).toHaveJSProperty("open", true);
    await expectOrder();

    emit({ type: "tool.completed", id: "history-c", status: "completed" });
    await expect(row("history-c").locator(".tool-status")).toHaveText("已完成");
    await expect(history).toHaveJSProperty("open", true);
    await expectOrder();
    await inspector.getByRole("button", { name: "关闭工具详情" }).click();
    await expect(history).toHaveJSProperty("open", true);
    await expectOrder();

    await history.locator("summary").click();
    emit({
      type: "tool.completed",
      id: "history-d",
      status: "failed",
      output: "history failure",
    });
    await expect(row("history-d").locator(".tool-status")).toHaveText("失败");
    await expect(history).toHaveJSProperty("open", false);
    await expectOrder();
    for (const id of ids.slice(0, 4)) await expect(row(id)).toBeHidden();
    await history.locator("summary").click();
    for (const id of ids) await expect(row(id)).toBeVisible();
    await expect(row("history-d")).toContainText("history failure");
    await expectOrder();

    emit({
      type: "tool.started",
      id: "history-g",
      tool: "command",
      input: { command: "run-history-g" },
    });
    await expect(history.locator("summary")).toHaveText(
      "较早 5 项 · command 5",
    );
    await expect(history).toHaveJSProperty("open", true);
    await expect
      .poll(() =>
        group
          .locator(".tool-card")
          .evaluateAll((rows) =>
            rows.map((element) => element.getAttribute("data-timeline-row")),
          ),
      )
      .toEqual([...ids, "history-g"]);
    await expect(
      history.locator('[data-timeline-row="history-e"]'),
    ).toBeVisible();
    await expect(
      group.locator(":scope > .tool-group-items > .tool-card"),
    ).toHaveCount(2);
    await expect(row("history-f")).toBeVisible();
    await expect(row("history-g")).toBeVisible();
  });

  test(`empty activity does not add tool spacing at ${viewport.width}px`, async ({
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
      id: "spacing-intro",
      text: "检查工具行间距。",
    });
    emit({
      type: "subagent.started",
      id: "spacing-child",
      agentId: "spacing-child",
      name: "Spacing worker",
    });
    for (const agentId of [undefined, "spacing-child"]) {
      const prefix = agentId ?? "main";
      const events: AgentTimelineEvent[] = [
        {
          type: "tool.started",
          id: `${prefix}-1`,
          tool: "command",
          input: { command: "pwd" },
        },
        { type: "tool.completed", id: `${prefix}-1`, status: "completed" },
        { type: "assistant.reasoning", id: `${prefix}-empty`, summary: [] },
        {
          type: "tool.started",
          id: `${prefix}-2`,
          tool: "command",
          input: { command: "npm rebuild node-pty" },
        },
        {
          type: "tool.completed",
          id: `${prefix}-2`,
          status: "failed",
          output: "npm error code EUNKNOWNCONFIG\nnpm error Unknown cli flag",
        },
        { type: "assistant.plan", id: `${prefix}-plan`, text: " \n " },
        {
          type: "tool.started",
          id: `${prefix}-3`,
          tool: "command",
          input: { command: "npm test" },
        },
        { type: "tool.completed", id: `${prefix}-3`, status: "completed" },
      ];
      for (const event of events) {
        emit(
          agentId === undefined
            ? event
            : { type: "subagent.event", id: event.id, agentId, event },
        );
      }
      if (agentId !== undefined) {
        await page.locator(".agent-switcher-trigger").click();
        await page
          .getByRole("option")
          .filter({ hasText: "Spacing worker" })
          .click();
      }
      const row = (index: number) =>
        page.locator(`[data-timeline-row="${prefix}-${index}"]`);
      await expect(row(3)).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath(`spacing-${prefix}-${viewport.width}.png`),
      });
      for (const index of [1, 2]) {
        const previous = await row(index).boundingBox();
        const next = await row(index + 1).boundingBox();
        expect(next!.y - (previous!.y + previous!.height)).toBeCloseTo(2, 0);
      }
      await expect(
        page.locator(`[data-timeline-row="${prefix}-empty"]`),
      ).toHaveCount(0);
      await expect(
        page.locator(`[data-timeline-row="${prefix}-plan"]`),
      ).toHaveCount(0);
      await expect(row(2)).toContainText("失败");
      await page
        .getByRole("button", { name: "Trajectory", exact: true })
        .click();
      const details = page.getByRole(
        viewport.width <= 760 ? "dialog" : "complementary",
        { name: "交互详情" },
      );
      for (const [label, id] of [
        ["思考摘要", `${prefix}-empty`],
        ["方案", `${prefix}-plan`],
      ]) {
        await page
          .getByRole("listitem")
          .filter({ hasText: label })
          .filter({
            hasText: agentId === undefined ? "Main Agent" : "Spacing worker",
          })
          .click();
        await expect(
          details.getByRole("button", { name: "在 Chat 中查看" }),
        ).toHaveCount(0);
        await details.getByRole("button", { name: "Raw", exact: true }).click();
        await expect(details).toContainText(id);
        await details.getByRole("button", { name: "关闭交互详情" }).click();
      }
      await page.getByRole("button", { name: "Chat", exact: true }).click();
    }
  });

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
    const inspector = page.getByRole(
      viewport.width <= 1100 ? "dialog" : "complementary",
      { name: "工具详情" },
    );
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
    await page.locator(".agent-switcher-trigger").click();
    await page.getByRole("option").filter({ hasText: "Worker" }).click();
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
