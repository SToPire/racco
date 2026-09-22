import type { WebSocketRoute } from "@playwright/test";
import type { ServerMessage, TimelineEvent } from "../../src/shared/protocol";
import { test, expect } from "./fixtures";

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
  await page.getByRole("button", { name: "Trajectory", exact: true }).click();
  const details = page.getByRole("complementary", { name: "交互详情" });
  await expect(details).toContainText("README.md");
  await details.getByRole("button", { name: "在 Chat 中查看" }).click();
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
  await page.getByRole("button", { name: "查看 Reviewer 的对话" }).click();
  await page.locator(".trajectory-tool-row").click();
  await page.getByRole("button", { name: "Trajectory", exact: true }).click();
  await expect(details).toContainText("子任务 · Step");
  await expect(details).not.toContainText("Turn 1 · Step");
  await details.getByRole("button", { name: "在 Chat 中查看" }).click();
  await expect(page.locator(".agent-switcher-trigger")).toContainText(
    "Reviewer",
  );
  await expect(page.locator(".trajectory-tool-row")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});
