import type { WebSocketRoute } from "@playwright/test";
import type { ServerMessage, TimelineEvent } from "../../src/shared/protocol";
import { test, expect } from "./fixtures";

for (const width of [1440, 390]) {
  test(`reveals folded tools from trajectory without moving them at ${width}px`, async ({
    page,
    racco,
  }) => {
    await page.setViewportSize({ width, height: 900 });
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
      text: "检查历史定位。",
    });
    const ids = ["earlier-failed", "earlier-completed", "recent-1", "recent-2"];
    for (const id of ids) {
      emit({
        type: "tool.started",
        id,
        tool: "Read",
        input: { file_path: `${id}.txt` },
      });
      emit({
        type: "tool.completed",
        id,
        status: id === "earlier-failed" ? "failed" : "completed",
      });
    }
    await expect(page.locator('[data-timeline-row="recent-2"]')).toBeVisible();
    for (const id of ids.slice(0, 2)) {
      await expect(page.locator(`[data-timeline-row="${id}"]`)).toBeHidden();
      await page.getByRole("button", { name: "执行轨迹", exact: true }).click();
      await page
        .getByRole("listitem")
        .filter({ hasText: `${id}.txt` })
        .click();
      await page
        .getByRole(width <= 760 ? "dialog" : "complementary", {
          name: "交互详情",
        })
        .getByRole("button", { name: "在对话中查看" })
        .click();
      const history = page.locator(".tool-history");
      const selected = history.locator(`[data-timeline-row="${id}"]`);
      await expect(history).toHaveJSProperty("open", true);
      await expect(selected).toBeVisible();
      await expect(selected).toHaveAttribute("aria-pressed", "true");
      await expect
        .poll(() =>
          page
            .locator(".tool-group")
            .last()
            .locator(".tool-card")
            .evaluateAll((rows) =>
              rows.map((element) => element.getAttribute("data-timeline-row")),
            ),
        )
        .toEqual(ids);
      await expect(history.locator(".tool-card")).toHaveCount(2);
      await page.getByRole("button", { name: "关闭工具详情" }).click();
      await history.locator("summary").click();
      await expect(selected).toBeHidden();
    }
  });
}

test("links selected Chat tools to trajectory and returns to the correct agent", async ({
  page,
  racco,
}) => {
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
  await page.locator(".tool-card").click();
  await page.getByRole("button", { name: "执行轨迹", exact: true }).click();
  const details = page.getByRole("complementary", { name: "交互详情" });
  await expect(details).toContainText("README.md");
  await details.getByRole("button", { name: "在对话中查看" }).click();
  await expect(page.locator(".tool-card")).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  emit({
    type: "subagent.started",
    id: "review",
    agentId: "reviewer",
    name: "Reviewer",
    prompt: "检查子任务",
  });
  emit({
    type: "subagent.event",
    id: "child-command-start",
    agentId: "reviewer",
    event: {
      type: "tool.started",
      id: "child-read",
      tool: "Read",
      input: { file_path: "src/index.ts" },
    },
  });
  await page.locator(".agent-switcher-trigger").click();
  await page.getByRole("option").filter({ hasText: "Reviewer" }).click();
  await page.locator(".trajectory-tool-row").click();
  await page.getByRole("button", { name: "执行轨迹", exact: true }).click();
  await expect(details).toContainText("子任务 · 步骤");
  await expect(details).not.toContainText("第 1 轮 · 步骤");
  await details.getByRole("button", { name: "在对话中查看" }).click();
  await expect(page.locator(".agent-switcher-trigger")).toContainText(
    "Reviewer",
  );
  await expect(page.locator(".trajectory-tool-row")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});
