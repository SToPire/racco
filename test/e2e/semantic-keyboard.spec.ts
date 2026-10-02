import type { WebSocketRoute } from "@playwright/test";
import { test, expect } from "./fixtures";

test("agent selection, request navigation and inspector tabs support their keyboard semantics", async ({
  page,
  racco,
}) => {
  let socket: WebSocketRoute | undefined;
  await page.routeWebSocket("**/api/ws", (route) => {
    socket = route;
    route.connectToServer();
  });
  await page.goto(`/session/${racco.sessions[0]!.sessionId}`);
  await expect(page.locator(".tool-card")).toBeVisible();
  for (const event of [
    {
      type: "subagent.started",
      id: "child-start",
      agentId: "child",
      name: "Keyboard reviewer",
      prompt: "Review",
    },
    {
      type: "user.message",
      id: "second-request",
      text: "Second request",
      imageCount: 0,
    },
  ])
    socket!.send(
      JSON.stringify({
        type: "timeline.event",
        session: { sessionId: racco.sessions[0]!.sessionId },
        event,
      }),
    );
  const agent = page.locator(".agent-switcher-trigger");
  await agent.focus();
  await page.keyboard.press("ArrowDown");
  const options = page
    .getByRole("listbox", { name: "切换 Agent" })
    .getByRole("option");
  await expect(options.first()).toBeFocused();
  await page.keyboard.press("End");
  await expect(options.last()).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(agent).toBeFocused();
  await expect(agent).toContainText("Keyboard reviewer");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Home");
  await page.keyboard.press("Enter");
  await expect(agent).toContainText("Main Agent");
  const navigator = page.locator(".turn-navigator-trigger");
  await navigator.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.locator(".turn-navigator-menu button[aria-current=true]"),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(navigator).toBeFocused();
  await page.locator(".tool-card").first().click();
  const tabs = page.getByRole("tablist", { name: "工具详情选项卡" });
  const selected = tabs.locator('[aria-selected="true"]');
  await selected.focus();
  await page.keyboard.press("Home");
  await expect(tabs.getByRole("tab").first()).toBeFocused();
  await expect(tabs.getByRole("tab").first()).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.keyboard.press("End");
  await expect(tabs.getByRole("tab").last()).toBeFocused();
  expect(await tabs.locator('[tabindex="0"]').count()).toBe(1);
  await page.getByRole("button", { name: "关闭工具详情" }).click();
  await page.getByRole("button", { name: "执行轨迹", exact: true }).click();
  await expect(
    page.getByRole("listitem").first().getByRole("button"),
  ).toBeVisible();
});
