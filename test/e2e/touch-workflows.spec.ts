import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

test.use({ fixtureProfile: "visual" });

async function openSession(page: Page, id: string) {
  await page.goto(`/session/${id}`);
  await page.getByRole("button", { name: "模型", exact: true }).tap();
  await page.getByRole("option", { name: /Fixture Primary/ }).tap();
  return page.getByRole("textbox", { name: "发送给 Racco" });
}

test("touch home project picker changes destination without losing the draft", async ({
  page,
}) => {
  await page.goto("/");
  expect(await page.evaluate(() => navigator.maxTouchPoints)).toBeGreaterThan(
    0,
  );
  await page.getByRole("button", { name: "项目", exact: true }).tap();
  await page.getByRole("option", { name: "alpha", exact: true }).tap();
  const input = page.getByRole("textbox", { name: "首条任务" });
  await input.tap();
  await input.fill("触摸草稿");
  await page.getByRole("button", { name: "项目", exact: true }).tap();
  await page.getByRole("option", { name: "beta", exact: true }).tap();
  await expect(
    page.getByRole("button", { name: "项目", exact: true }),
  ).toHaveText("beta");
  await expect(input).toHaveValue("触摸草稿");
  await page.getByRole("button", { name: "项目", exact: true }).tap();
  await page.getByRole("option", { name: "alpha", exact: true }).tap();
  await expect(input).toHaveValue("触摸草稿");
  await expect(
    page.getByRole("button", { name: "新建并发送" }),
  ).toBeInViewport();
});

test("touch send commits one user message and clears the draft", async ({
  page,
  racco,
}) => {
  const input = await openSession(page, racco.sessions[0]!.sessionId);
  await input.tap();
  await input.fill("移动端任务");
  await page.getByRole("button", { name: "发送", exact: true }).tap();
  await expect(page.locator(".run-state")).toHaveText("空闲");
  await expect(page.locator(".message-user").last()).toHaveText("移动端任务");
  await expect(input).toHaveValue("");
});

test("touch question choices and Other survive view changes", async ({
  page,
  racco,
}) => {
  const input = await openSession(page, racco.sessions[0]!.sessionId);
  await input.fill("question-other");
  await page.getByRole("button", { name: "发送", exact: true }).tap();
  const alpha = page.getByRole("checkbox", { name: "Alpha", exact: true });
  await alpha.tap();
  const other = page.getByRole("textbox", { name: "选择多个选项 的文本回答" });
  await other.tap();
  await other.fill("其他选择");
  await page.getByRole("radio", { name: "Gamma", exact: true }).tap();
  await page.getByRole("button", { name: "执行轨迹", exact: true }).tap();
  await expect(alpha).toBeChecked();
  await expect(other).toHaveValue("其他选择");
  await page.getByRole("button", { name: "提交回答", exact: true }).tap();
  await expect(page.locator(".run-state")).toHaveText("空闲");
});

test("touch trajectory can interrupt without losing the next draft", async ({
  page,
  racco,
}) => {
  const input = await openSession(page, racco.sessions[0]!.sessionId);
  await input.fill("wait");
  await page.getByRole("button", { name: "发送", exact: true }).tap();
  await expect(page.locator(".run-state")).toHaveText("运行中");
  await input.fill("下一条草稿");
  await page.getByRole("button", { name: "执行轨迹", exact: true }).tap();
  await page.getByRole("button", { name: "停止生成", exact: true }).tap();
  await expect(page.locator(".run-state")).toHaveText("已中断");
  await expect(input).toHaveValue("下一条草稿");
  await expect(
    page.getByRole("button", { name: "发送", exact: true }),
  ).toBeEnabled();
});
