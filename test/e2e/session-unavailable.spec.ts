import { test, expect } from "./fixtures";

test("mobile missing session stops loading, retries and returns to projects", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let subscriptions = 0;
  await page.routeWebSocket("**/api/ws", (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => {
      if (JSON.parse(message.toString()).type === "session.subscribe")
        subscriptions++;
      server.send(message);
    });
  });
  await page.goto("/session/missing");
  await expect(
    page.getByRole("heading", { name: "会话不存在或已删除" }),
  ).toBeVisible();
  await expect(page.getByText("正在读取对话…")).toHaveCount(0);
  await page.getByRole("button", { name: "重试读取" }).click();
  await expect.poll(() => subscriptions).toBe(2);
  await page.getByRole("button", { name: "返回项目" }).click();
  await expect(page).not.toHaveURL(/\/session\//);
  await expect(
    page.getByRole("button", { name: "新建对话", exact: true }),
  ).toBeVisible();
});

test("the home composer loads without an active subscription", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "首条任务" })).toBeVisible();
  expect(errors).toEqual([]);
});
