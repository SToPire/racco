import type { WebSocketRoute } from "@playwright/test";
import type { ServerMessage, TimelineEvent } from "../../src/shared/protocol";
import { test, expect } from "./fixtures";

test("follows live output until the reader scrolls away and restores reading across views", async ({
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
  await expect(page.locator(".tool-card")).toBeVisible();
  const body = Array.from(
    { length: 60 },
    (_, index) => `第 ${index + 1} 段：正在检查工具展示与任务状态。`,
  ).join("\n\n");
  emit({
    type: "assistant.message",
    id: "long-output",
    text: body,
    partial: true,
  });
  const conversation = page.locator(".conversation");
  const distance = () =>
    conversation.evaluate(
      (element) =>
        element.scrollHeight - element.scrollTop - element.clientHeight,
    );
  await expect.poll(distance).toBeLessThan(3);
  await conversation.evaluate((element) =>
    element.scrollTo({ top: 120, behavior: "instant" }),
  );
  await expect(
    page.getByRole("button", { name: "回到最新内容 ↓" }),
  ).toBeVisible();
  const top = await conversation.evaluate((element) => element.scrollTop);
  emit({
    type: "assistant.message",
    id: "long-output",
    text: `${body}\n\n新的执行结果`,
    partial: true,
  });
  await expect(conversation).toContainText("新的执行结果");
  await expect
    .poll(() => conversation.evaluate((element) => element.scrollTop))
    .toBe(top);
  await page.getByRole("button", { name: "Trajectory", exact: true }).click();
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect
    .poll(() => conversation.evaluate((element) => element.scrollTop))
    .toBe(top);
  await page.getByRole("button", { name: "回到最新内容 ↓" }).click();
  await expect.poll(distance).toBeLessThan(3);
  await expect(
    page.getByRole("button", { name: "回到最新内容 ↓" }),
  ).toHaveCount(0);
});
