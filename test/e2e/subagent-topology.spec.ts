import type { WebSocketRoute } from "@playwright/test";
import type { ServerMessage, TimelineEvent } from "../../src/shared/protocol";
import { test, expect } from "./fixtures";

for (const provider of ["codex", "claude"] as const) {
  test(`${provider} subagents preserve the selected conversation and tool until the user opens a task`, async ({
    page,
    racco,
  }) => {
    await page.setViewportSize({ width: 2200, height: 900 });
    const session = racco.sessions.find(
      (candidate) => candidate.provider === provider,
    )!;
    let socket: WebSocketRoute | undefined;
    await page.routeWebSocket("**/api/ws", (route) => {
      socket = route;
      route.connectToServer();
    });
    function emit(event: TimelineEvent) {
      if (socket === undefined)
        throw new Error("The session socket is not connected");
      socket.send(
        JSON.stringify({
          type: "timeline.event",
          session: { sessionId: session.sessionId },
          event,
        } satisfies ServerMessage),
      );
    }

    await page.goto(`/session/${session.sessionId}`);
    const mainReply = page
      .locator(".timeline")
      .getByText("这是固定的开发测试场景。", { exact: false });
    await expect(mainReply).toBeVisible();
    await page.locator(".conversation button[aria-pressed]").first().click();
    const inspector = page.getByRole("complementary", { name: "工具详情" });
    await expect(inspector).toBeVisible();

    emit({
      type: "subagent.started",
      id: "reviewer-started",
      agentId: "reviewer",
      name: "Reviewer",
      prompt: "检查会话导航",
    });
    emit({
      type: "subagent.state",
      id: "reviewer-running",
      agentId: "reviewer",
      state: "running",
      message: "正在检查导航状态",
    });
    emit({
      type: "subagent.event",
      id: "reviewer-task-event",
      agentId: "reviewer",
      event: {
        type: "user.message",
        id: "reviewer-task",
        text: "检查会话导航",
      },
    });
    emit({
      type: "subagent.event",
      id: "reviewer-reply-event",
      agentId: "reviewer",
      event: {
        type: "assistant.message",
        id: "reviewer-reply",
        text: "子任务的详细检查记录",
      },
    });
    const reviewerCard = page.getByRole("button", {
      name: "查看 Reviewer 的对话",
    });
    await expect(reviewerCard).toBeVisible();
    await expect(page.locator(".conversation .subagent-topology")).toHaveCount(
      0,
    );
    await expect(reviewerCard).toContainText("检查会话导航");
    await expect(reviewerCard).toContainText("正在检查导航状态");
    await expect(page.locator(".agent-switcher-trigger")).toContainText(
      "Main Agent",
    );
    await expect(mainReply).toBeVisible();
    await expect(inspector).toBeVisible();
    await expect(
      page.getByText("子任务的详细检查记录", { exact: true }),
    ).toHaveCount(0);

    await reviewerCard.click();
    await expect(page.locator(".agent-switcher-trigger")).toContainText(
      "Reviewer",
    );
    await expect(
      page.getByText("子任务的详细检查记录", { exact: true }),
    ).toBeVisible();
    await expect(inspector).toHaveCount(0);
    await expect(page.locator(".timeline .message-user")).toHaveCount(1);
    await expect(reviewerCard).toHaveAttribute("aria-current", "true");

    emit({
      type: "subagent.started",
      id: "tester-started",
      agentId: "tester",
      name: "Tester",
      prompt: "验证导航行为",
    });
    emit({
      type: "subagent.state",
      id: "tester-running",
      agentId: "tester",
      state: "running",
    });
    await page.locator(".agent-switcher-trigger").click();
    await expect(
      page.getByRole("option").filter({ hasText: "Tester" }),
    ).toBeVisible();
    await expect(page.locator(".agent-switcher-trigger")).toContainText(
      "Reviewer",
    );
    await expect(
      page.getByText("子任务的详细检查记录", { exact: true }),
    ).toBeVisible();
    await page.getByRole("option").filter({ hasText: "Main Agent" }).click();
    await expect(mainReply).toBeVisible();
    await expect(
      page.getByRole("button", { name: "查看 Tester 的对话" }),
    ).toBeVisible();

    emit({
      type: "subagent.state",
      id: "reviewer-completed",
      agentId: "reviewer",
      state: "completed",
      message: "已确认主对话和工具选择保持不变",
    });
    await expect(reviewerCard).toContainText("已完成");
    await expect(reviewerCard).toContainText("已确认主对话和工具选择保持不变");
    await expect(reviewerCard).not.toContainText("正在检查导航状态");
    await expect(page.locator(".agent-switcher-trigger")).toContainText(
      "Main Agent",
    );
    await reviewerCard.click();
    await expect(
      page.getByText("子任务的详细检查记录", { exact: true }),
    ).toBeVisible();
  });
}

test("topology stays bounded, connects nested tasks, and remains usable on narrow screens", async ({
  page,
  racco,
}) => {
  await page.setViewportSize({ width: 1920, height: 900 });
  const session = racco.sessions.find((entry) => entry.provider === "codex")!;
  let socket: WebSocketRoute | undefined;
  await page.routeWebSocket("**/api/ws", (route) => {
    socket = route;
    route.connectToServer();
  });
  await page.goto(`/session/${session.sessionId}`);
  await expect(page.locator(".timeline")).toBeVisible();
  function emit(event: TimelineEvent) {
    if (!socket) throw new Error("Session socket missing");
    socket.send(
      JSON.stringify({
        type: "timeline.event",
        session: { sessionId: session.sessionId },
        event,
      } satisfies ServerMessage),
    );
  }
  const beforeHeight = await page
    .locator(".conversation")
    .evaluate((element) => element.scrollHeight);
  const beforeTimeline = (await page.locator(".timeline").boundingBox())!;
  emit({
    type: "subagent.started",
    id: "nested",
    agentId: "nested",
    parentAgentId: "worker-0",
    name: "Nested",
  });
  for (let i = 0; i < 30; i++) {
    emit({
      type: "subagent.started",
      id: `start-${i}`,
      agentId: `worker-${i}`,
      name: `Worker ${i}`,
    });
  }
  emit({
    type: "subagent.event",
    id: "worker-29-reasoning",
    agentId: "worker-29",
    event: {
      type: "assistant.reasoning",
      id: "worker-29-reasoning",
      summary: [],
      partial: true,
    },
  });
  const panel = page.getByRole("complementary", { name: "子 Agent 拓扑" });
  const toggle = panel.getByRole("button", { name: "子 Agent 31" });
  await expect(
    panel.getByRole("button", { name: "查看 Worker 29 的对话", exact: true }),
  ).toBeAttached();
  await expect(
    panel.locator('[data-agent-id="worker-0"] [data-agent-id="nested"]'),
  ).toHaveCount(1);
  const content = panel.locator(".subagent-topology-content");
  expect(
    await content.evaluate(
      (element) => element.scrollHeight > element.clientHeight,
    ),
  ).toBe(true);
  const panelBox = (await panel.boundingBox())!;
  const conversationBox = (await page.locator(".conversation").boundingBox())!;
  const timelineBox = (await page.locator(".timeline").boundingBox())!;
  const composerBox = (await page.locator(".composer-stack").boundingBox())!;
  expect(timelineBox.x).toBeCloseTo(beforeTimeline.x, 1);
  expect(timelineBox.width).toBeCloseTo(beforeTimeline.width, 1);
  expect(timelineBox.x + timelineBox.width / 2).toBeCloseTo(
    composerBox.x + composerBox.width / 2,
    1,
  );
  expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(timelineBox.x);
  expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(
    conversationBox.y + conversationBox.height,
  );
  // Adding many tasks must not append their height to the conversation.
  expect(
    await page
      .locator(".conversation")
      .evaluate((element) => element.scrollHeight),
  ).toBeLessThan(beforeHeight + 500);
  await panel.getByRole("button", { name: "查看 Nested 的对话" }).click();
  await expect(page.locator(".agent-switcher-trigger")).toContainText("Nested");
  await panel.getByRole("button", { name: "查看 Main Agent 的对话" }).click();
  await expect(page.locator(".agent-switcher-trigger")).toContainText(
    "Main Agent",
  );

  await page.getByRole("button", { name: "Trajectory", exact: true }).click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  const tabsBox = (await page.locator(".session-view-tabs").boundingBox())!;
  const trajectoryToggleBox = (await panel.boundingBox())!;
  expect(trajectoryToggleBox.y).toBeGreaterThanOrEqual(tabsBox.y);
  expect(
    trajectoryToggleBox.y + trajectoryToggleBox.height,
  ).toBeLessThanOrEqual(tabsBox.y + tabsBox.height);
  await page
    .locator(".trajectory-entry")
    .first()
    .click({
      position: { x: 20, y: 4 },
    });
  await expect(
    page.getByRole("button", { name: "Trajectory", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("complementary", { name: "交互详情" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");

  await page.setViewportSize({ width: 1600, height: 900 });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  const beforeExpand = (await page.locator(".timeline").boundingBox())!;
  await toggle.click();
  await expect(content).toBeVisible();
  const afterExpand = (await page.locator(".timeline").boundingBox())!;
  const compactComposer = (await page
    .locator(".composer-stack")
    .boundingBox())!;
  expect(afterExpand.x).toBeCloseTo(beforeExpand.x, 1);
  expect(afterExpand.width).toBeCloseTo(beforeExpand.width, 1);
  expect(afterExpand.x + afterExpand.width / 2).toBeCloseTo(
    compactComposer.x + compactComposer.width / 2,
    1,
  );
  await toggle.click();
  await expect(content).toBeHidden();
  expect((await page.locator(".timeline").boundingBox())!.x).toBeCloseTo(
    beforeExpand.x,
    1,
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  const chatTabsBox = (await page.locator(".session-view-tabs").boundingBox())!;
  const chatMenuBox = (await panel.boundingBox())!;
  const chatToggleBox = (await toggle.boundingBox())!;
  expect(chatToggleBox.y).toBeGreaterThanOrEqual(chatTabsBox.y);
  expect(chatToggleBox.y + chatToggleBox.height).toBeLessThanOrEqual(
    chatTabsBox.y + chatTabsBox.height,
  );
  await toggle.click();
  await expect(content).toBeVisible();
  const narrowBox = (await panel.boundingBox())!;
  const footerBox = (await page.locator(".session-footer").boundingBox())!;
  expect(narrowBox.y).toBeCloseTo(chatMenuBox.y, 1);
  expect(narrowBox.x + narrowBox.width).toBeCloseTo(
    chatMenuBox.x + chatMenuBox.width,
    1,
  );
  expect(narrowBox.x).toBeGreaterThanOrEqual(0);
  expect(narrowBox.x + narrowBox.width).toBeLessThanOrEqual(390);
  expect(narrowBox.y + narrowBox.height).toBeLessThanOrEqual(footerBox.y);
  await panel
    .getByRole("button", { name: "查看 Worker 29 的对话", exact: true })
    .click();
  await expect(page.locator(".agent-switcher-trigger")).toContainText(
    "Worker 29",
  );
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  const reasoning = page.locator(".reasoning-summary > summary");
  await expect(reasoning).toContainText("正在整理思路");
  const reasoningBox = (await reasoning.boundingBox())!;
  const collapsedBox = (await panel.boundingBox())!;
  expect(collapsedBox.y + collapsedBox.height).toBeLessThanOrEqual(
    reasoningBox.y,
  );
  await reasoning.click({ position: { x: 24, y: 2 } });
  await expect(page.locator(".reasoning-summary")).toHaveAttribute("open", "");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await page.keyboard.press("Escape");
  await expect(toggle).toBeFocused();
  await expect(content).toBeHidden();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);

  await page.getByRole("button", { name: "Trajectory", exact: true }).click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  const narrowTabsBox = (await page
    .locator(".session-view-tabs")
    .boundingBox())!;
  const narrowToggleBox = (await panel.boundingBox())!;
  const viewSwitchBox = (await page
    .locator(".segmented-switch")
    .boundingBox())!;
  expect(narrowToggleBox.x).toBeGreaterThanOrEqual(
    viewSwitchBox.x + viewSwitchBox.width,
  );
  expect(narrowToggleBox.x + narrowToggleBox.width).toBeLessThanOrEqual(390);
  expect(narrowToggleBox.y).toBeGreaterThanOrEqual(narrowTabsBox.y);
  expect(narrowToggleBox.y + narrowToggleBox.height).toBeLessThanOrEqual(
    narrowTabsBox.y + narrowTabsBox.height,
  );
});
