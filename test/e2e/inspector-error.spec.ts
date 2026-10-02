import type { WebSocketRoute } from "@playwright/test";
import { test, expect } from "./fixtures";

test("malformed provider details remain local and closing them keeps chat usable", async ({
  page,
  racco,
}) => {
  let socket: WebSocketRoute | undefined;
  await page.routeWebSocket("**/api/ws", (route) => {
    socket = route;
    route.connectToServer();
  });
  const sessionId = racco.sessions[0].sessionId;
  await page.goto(`/session/${sessionId}`);
  await expect(page.locator(".tool-card")).toBeVisible();
  socket!.send(
    JSON.stringify({
      type: "timeline.event",
      session: { sessionId },
      event: {
        type: "tool.started",
        id: "broken-details",
        tool: "command",
        input: { command: "broken-details" },
        details: { command: "broken-details" },
      },
    }),
  );
  await page.locator('[data-timeline-row="broken-details"]').click();
  await expect(page.locator(".tool-inspector")).toBeVisible();
  await page.getByRole("button", { name: "关闭工具详情" }).click();
  await expect(page.locator(".tool-inspector")).toHaveCount(0);
  await expect(page.locator(".composer textarea")).toBeVisible();
});
