import { test, expect } from "./fixtures";

test("recovering only Codex preserves the draft and exposes busy refusal", async ({
  page,
  racco,
}) => {
  let attempts = 0;
  await page.route("**/api/providers/codex/restart", async (route) => {
    attempts++;
    await route.fulfill(
      attempts === 1
        ? { status: 409, json: { message: "Codex 仍有子 Agent 运行" } }
        : {
            json: { ok: true, providers: { codex: "ready", claude: "ready" } },
          },
    );
  });
  await page.goto(`/session/${racco.sessions[0].sessionId}`);
  await page.getByRole("button", { name: "新建对话", exact: true }).click();
  const input = page.getByRole("textbox", { name: "首条任务" });
  await input.fill("Keep this draft through provider recovery");
  await page.getByText("Codex 连接与会话释放", { exact: true }).click();
  await page.getByRole("button", { name: "释放空闲 Codex 会话" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Codex 仍有子 Agent 运行",
  );
  await expect(input).toHaveValue("Keep this draft through provider recovery");
  await page.getByRole("button", { name: "释放空闲 Codex 会话" }).click();
  await expect(page.getByRole("status")).toContainText("任务不会自动重发");
  await expect(input).toHaveValue("Keep this draft through provider recovery");
  expect(attempts).toBe(2);
});
