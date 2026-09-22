import type { Page } from "@playwright/test";
import type { ClientCommand, ServerMessage } from "../../src/shared/protocol";
import { test, expect } from "./fixtures";

async function openSession(page: Page, sessionId: string) {
  await page.goto(`/session/${sessionId}`);
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await page.getByRole("option", { name: /Fixture Primary/ }).click();
  return page.getByRole("textbox", { name: "发送给 Racco" });
}

function observeTurnStarts(page: Page) {
  const prompts: string[] = [];
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      const command = JSON.parse(String(payload)) as ClientCommand;
      if (command.type === "turn.start") prompts.push(command.prompt);
    });
  });
  return prompts;
}

test("running tasks allow drafts across views and can be stopped from the trajectory", async ({
  page,
  racco,
}) => {
  const prompts = observeTurnStarts(page);
  const input = await openSession(page, racco.sessions[0]!.sessionId);
  const send = page.getByRole("button", { name: "发送", exact: true });
  await input.fill("wait");
  await send.click();
  await expect(page.locator(".run-state")).toHaveText("运行中");
  await expect(input).toHaveValue("");
  await expect(input).toBeEnabled();

  await input.fill("next task draft");
  await expect(send).toBeDisabled();
  await input.press("Enter");
  await expect(input).toHaveValue("next task draft");
  expect(prompts).toEqual(["wait"]);
  await page.getByRole("button", { name: "Trajectory", exact: true }).click();
  await expect(input).toHaveValue("next task draft");
  await expect(input).toBeEnabled();
  const search = page.getByRole("searchbox", { name: "搜索交互" });
  await search.fill("README.md");
  await page.locator(".trajectory-entry").first().click();
  const details = page.getByRole("complementary", { name: "交互详情" });
  await expect(details).toBeVisible();
  await input.fill("next task from trajectory");
  await input.press("Enter");
  expect(prompts).toEqual(["wait"]);
  await expect(send).toBeDisabled();

  await page.getByRole("button", { name: "停止生成", exact: true }).click();
  await expect(page.locator(".run-state")).toHaveText("已停止");
  await expect(input).toHaveValue("next task from trajectory");
  await expect(send).toBeEnabled();
  await expect(search).toHaveValue("README.md");
  await expect(details).toBeVisible();
  await send.click();
  await expect(input).toHaveValue("");
  await expect(page.locator(".run-state")).toHaveText("空闲");
  expect(prompts).toEqual(["wait", "next task from trajectory"]);
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(page.locator(".message-user").last()).toHaveText(
    "next task from trajectory",
  );
});

test("unsubmitted answers and next-task drafts survive switching to trajectory", async ({
  page,
  racco,
}) => {
  const prompts = observeTurnStarts(page);
  const input = await openSession(page, racco.sessions[0]!.sessionId);
  const send = page.getByRole("button", { name: "发送", exact: true });
  await input.fill("question");
  await send.click();
  await expect(page.locator(".run-state")).toHaveText("等待操作");
  await expect(input).toHaveValue("");
  await expect(input).toBeEnabled();
  await input.fill("draft after answering");
  await input.press("Enter");
  await expect(send).toBeDisabled();
  await page.getByRole("radio", { name: "Alpha", exact: true }).check();

  await page.getByRole("button", { name: "Trajectory", exact: true }).click();
  await expect(
    page.getByRole("radio", { name: "Alpha", exact: true }),
  ).toBeChecked();
  await expect(input).toHaveValue("draft after answering");
  await expect(
    page.getByRole("button", { name: "停止生成", exact: true }),
  ).toBeVisible();
  await page.getByRole("searchbox", { name: "搜索交互" }).fill("question");
  await expect(page.locator(".trajectory-entry").first()).toBeVisible();
  await page.getByRole("button", { name: "提交回答", exact: true }).click();
  await expect(page.locator(".run-state")).toHaveText("空闲");
  await expect(
    page.getByRole("button", { name: "提交回答", exact: true }),
  ).toHaveCount(0);
  await expect(
    page
      .locator(".trajectory-entry")
      .filter({ hasText: "Fixture: question (answer)" }),
  ).toBeVisible();
  await expect(input).toHaveValue("draft after answering");
  await expect(send).toBeEnabled();
  expect(prompts).toEqual(["question"]);
});

test("an unconfirmed send locks the draft even after the task starts and the view changes", async ({
  page,
  racco,
}) => {
  let turnRequestId: string | undefined;
  let releaseAcknowledgement: (() => void) | undefined;
  await page.routeWebSocket("**/api/ws", (route) => {
    const server = route.connectToServer();
    route.onMessage((message) => {
      const command = JSON.parse(String(message)) as ClientCommand;
      if (command.type === "turn.start") turnRequestId = command.requestId;
      server.send(message);
    });
    server.onMessage((message) => {
      const response = JSON.parse(String(message)) as ServerMessage;
      if (response.type === "ack" && response.requestId === turnRequestId) {
        releaseAcknowledgement = () => route.send(message);
      } else {
        route.send(message);
      }
    });
  });
  const input = await openSession(page, racco.sessions[0]!.sessionId);
  await input.fill("wait");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.locator(".run-state")).toHaveText("运行中");
  await expect.poll(() => releaseAcknowledgement !== undefined).toBe(true);
  await expect(input).toBeDisabled();
  await expect(input).toHaveValue("wait");
  await page.getByRole("button", { name: "Trajectory", exact: true }).click();
  await expect(input).toBeDisabled();
  await expect(input).toHaveValue("wait");
  releaseAcknowledgement!();
  await expect(input).toHaveValue("");
  await expect(input).toBeEnabled();
  await input.fill("draft after confirmed send");
  await expect(
    page.getByRole("button", { name: "发送", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "停止生成", exact: true }).click();
  await expect(page.locator(".run-state")).toHaveText("已停止");
  await expect(input).toHaveValue("draft after confirmed send");
});

test("mobile trajectory details leave pending questions and navigation reachable", async ({
  page,
  racco,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const input = await openSession(page, racco.sessions[0]!.sessionId);
  await input.fill("question");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(
    page.getByText("Fixture question", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Trajectory", exact: true }).click();
  await page.locator(".trajectory-entry").first().click();
  await expect(
    page.getByRole("complementary", { name: "交互详情" }),
  ).toBeVisible();
  await page.getByRole("radio", { name: "Alpha", exact: true }).check();
  await page.getByRole("button", { name: "提交回答" }).click();
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(
    page.getByText("Fixture: question (answer)", { exact: true }),
  ).toBeVisible();
});
