import type { WebSocketRoute } from "@playwright/test";
import { test, expect } from "./fixtures";

test("mobile execution target remains inspectable and disconnected drafts stay editable until explicit send", async ({
  page,
  racco,
}) => {
  let connected = true;
  let socket: WebSocketRoute | undefined;
  await page.routeWebSocket("**/api/ws", (route) => {
    socket = route;
    if (connected) route.connectToServer();
    else route.close({ code: 4000 });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/session/${racco.sessions[0]!.sessionId}`);
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await page.getByRole("option", { name: /Fixture Primary/ }).click();
  await page.locator(".session-send-target summary").click();
  await expect(page.getByLabel("执行目录")).toBeVisible();
  await expect(page.getByLabel("执行目录")).toHaveText(racco.projects[0]!.path);
  await expect(page.locator(".session-send-target summary")).toContainText(
    "Codex",
  );
  connected = false;
  socket!.close({ code: 4000 });
  await expect(
    page.getByRole("status", { name: "连接状态", exact: true }),
  ).toContainText("连接已断开");
  const input = page.getByRole("textbox", { name: "发送给 Racco" });
  await input.fill("prepared while offline");
  await expect(
    page.getByRole("button", { name: "发送", exact: true }),
  ).toBeDisabled();
  await expect(page.locator(".composer-hint")).toContainText(
    "恢复后请手动发送",
  );
  connected = true;
  await expect(
    page.getByRole("status", { name: "连接状态", exact: true }),
  ).toContainText("已连接");
  await expect(input).toHaveValue("prepared while offline");
  await expect(
    page.getByRole("button", { name: "发送", exact: true }),
  ).toBeEnabled();
  await expect(page.locator(".timeline")).not.toContainText(
    "prepared while offline",
  );
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(
    page.getByText("Fixture: prepared while offline", { exact: true }),
  ).toBeVisible();
});
