import type { WebSocketRoute } from "@playwright/test";
import type { ServerMessage, TimelineEvent } from "../../src/shared/protocol";
import { test, expect } from "./fixtures";

for (const provider of ["codex", "claude"] as const) {
  test(`${provider} subagents preserve the selected conversation and tool until the user opens a task`, async ({
    page,
    racco,
  }) => {
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
