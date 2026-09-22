import { test, expect } from "./fixtures";

test("browser navigation restores the narrow history list separately from the home composer", async ({
  page,
  racco,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "首条任务" });
  const sidebar = page.locator(".sidebar");
  await expect(input).toBeVisible();
  await page.getByRole("button", { name: "返回对话历史" }).click();
  await expect(sidebar).toBeVisible();
  await page
    .locator(".history-row")
    .filter({ hasText: racco.sessions[0]!.title! })
    .click();
  await expect(page).toHaveURL(`/session/${racco.sessions[0]!.sessionId}`);

  await page.goBack();
  await expect(page).toHaveURL("/");
  await expect(sidebar).toBeVisible();
  await expect(input).toBeHidden();
  await page.goBack();
  await expect(input).toBeVisible();
  await expect(sidebar).toBeHidden();
  await page.goForward();
  await expect(sidebar).toBeVisible();
  await expect(input).toBeHidden();
  await page.reload();
  await expect(sidebar).toBeVisible();
  await expect(input).toBeHidden();
  await page.goForward();
  await expect(page).toHaveURL(`/session/${racco.sessions[0]!.sessionId}`);
  await expect(
    page.getByRole("textbox", { name: "发送给 Racco" }),
  ).toBeVisible();
  await expect(sidebar).toBeHidden();
});

for (const button of ["在项目 beta 中新建对话", "新建对话"]) {
  test(`the narrow composer regains focus and preserves its draft after ${button}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    const input = page.getByRole("textbox", { name: "首条任务" });
    await expect(input).toBeFocused();
    await input.fill("draft");
    await page.getByRole("button", { name: "返回对话历史" }).click();
    await expect(input).toBeHidden();
    await page.getByRole("button", { name: button, exact: true }).click();
    if (button === "在项目 beta 中新建对话") {
      await expect(
        page.getByRole("button", { name: "项目", exact: true }),
      ).toHaveText("beta");
    }
    await expect(input).toBeFocused();
    await page.keyboard.type(" continued");
    await expect(input).toHaveValue("draft continued");

    await page.goBack();
    await expect(page.locator(".sidebar")).toBeVisible();
    await expect(input).toBeHidden();
    await page.goForward();
    await expect(input).toBeFocused();
    await expect(input).toHaveValue("draft continued");
  });
}

test("browser history returns to the home composer and restores the selected conversation", async ({
  page,
  racco,
}) => {
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "首条任务" })).toBeVisible();
  await page
    .locator(".history-row")
    .filter({ hasText: racco.sessions[0]!.title! })
    .click();
  await expect(
    page.getByRole("textbox", { name: "发送给 Racco" }),
  ).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("textbox", { name: "首条任务" })).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(`/session/${racco.sessions[0]!.sessionId}`);
  await expect(
    page.getByRole("textbox", { name: "发送给 Racco" }),
  ).toBeVisible();
});

test("the home composer offers project import and prevents sending without a project", async ({
  page,
}) => {
  await page.route("**/api/projects", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/sessions", (route) => route.fulfill({ json: [] }));
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "首条任务" });
  await expect(input).toBeVisible();
  await expect(
    page.getByRole("button", { name: "项目", exact: true }),
  ).toHaveText("请先导入项目");
  await input.fill("等待导入项目");
  await input.press("Enter");
  await expect(input).toHaveValue("等待导入项目");
  await expect(page.getByRole("button", { name: "新建并发送" })).toBeDisabled();
  await page.getByRole("button", { name: "项目", exact: true }).click();
  await page.getByRole("button", { name: "导入项目…", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "导入项目", exact: true }),
  ).toBeVisible();
});

test("project creation, turn completion and live catalog updates across browsers", async ({
  page,
  context,
  racco,
}) => {
  const other = await context.newPage();
  await Promise.all([page.goto("/"), other.goto("/")]);
  await page
    .getByRole("region", { name: "项目 alpha", exact: true })
    .locator(".project-tree-header")
    .hover();
  await page
    .getByRole("button", { name: "在项目 alpha 中新建对话", exact: true })
    .click();
  const projectPicker = page.getByRole("button", { name: "项目", exact: true });
  await expect(projectPicker).toHaveText(racco.projects[0]!.name);
  await projectPicker.click();
  await expect(
    page.getByRole("option", { name: "alpha", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "导入项目…", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "导入项目", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(projectPicker).toBeFocused();
  await projectPicker.click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await expect(projectPicker).toHaveText("beta");
  await projectPicker.click();
  await page.getByRole("option", { name: "alpha", exact: true }).click();
  await page.getByRole("textbox", { name: "首条任务" }).fill("browser-check");
  await page.getByRole("button", { name: "新建并发送" }).click();
  await expect(page).toHaveURL(/\/session\//);
  await expect(
    page.getByText("Fixture: browser-check", { exact: true }),
  ).toBeVisible();
  const title = await page.locator(".session-title-line h1").innerText();
  await expect(
    other.locator(".history-row").filter({ hasText: title }),
  ).toBeVisible();
  await page.getByRole("textbox", { name: "发送给 Racco" }).fill("followup");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(
    page.getByText("Fixture: followup", { exact: true }),
  ).toBeVisible();
});

test("Files tabs remain separate from conversation and inspector state", async ({
  page,
  racco,
}) => {
  await page.goto(`/session/${racco.sessions[0]!.sessionId}`);
  await page.getByRole("button", { name: "展开文件侧栏" }).click();
  const dock = page.getByRole("complementary", { name: "文件侧栏" });
  await dock.getByRole("button", { name: "目录 src", exact: true }).click();
  await dock
    .getByRole("button", { name: "文件 src/index.ts", exact: true })
    .click();
  await expect(
    dock.getByRole("tabpanel", { name: "index.ts", exact: true }),
  ).toContainText("answer = 42");
  await expect(page.locator(".file-tree")).toBeHidden();
  await page.locator(".tool-group > summary").click();
  await page.locator(".tool-card").click();
  await expect(
    page.getByRole("complementary", { name: "工具详情" }),
  ).toBeVisible();
  await dock.getByRole("button", { name: "折叠文件侧栏" }).click();
  await expect(
    page.getByRole("complementary", { name: "工具详情" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "展开文件侧栏" }).click();
  await expect(dock.getByRole("tab", { name: "index.ts" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.getByRole("button", { name: "关闭工具详情" }).click();
  await page.getByRole("button", { name: "Trajectory", exact: true }).click();
  await expect(dock.getByRole("tab", { name: "index.ts" })).toBeVisible();
  await dock.getByRole("tab", { name: "Files", exact: true }).click();
  await expect(
    dock.getByRole("button", { name: "目录 src", exact: true }),
  ).toHaveAttribute("aria-expanded", "true");
  await dock.getByRole("button", { name: "关闭文件 src/index.ts" }).click();
  await expect(
    dock.getByRole("tab", { name: "Files", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
});

test("directory navigation is read-only until import and file previews do not execute HTML", async ({
  page,
  racco,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "导入项目", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("navigation", { name: "当前目录" }),
  ).toBeVisible();
  const input = dialog.getByRole("textbox", { name: "目录路径" });
  await input.fill(racco.projects[0]!.path + "/missing");
  await input.press("Enter");
  await expect(dialog.getByRole("alert")).toBeVisible();
  await input.fill(racco.projects[0]!.path);
  await input.press("Enter");
  await expect(
    dialog.getByRole("button", { name: "选择文件夹 src", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "展开文件侧栏" }).click();
  await page
    .getByRole("button", { name: "文件 unsafe.html", exact: true })
    .click();
  await expect(page.locator(".file-code-grid")).toContainText(
    "window.previewExecuted=true",
  );
  expect(await page.evaluate(() => "previewExecuted" in window)).toBe(false);
});

test("compact layout, theme, question and interrupt controls work with fixture provider", async ({
  page,
  racco,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/session/${racco.sessions[1]!.sessionId}`);
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await page.getByRole("option", { name: /Fixture Primary/ }).click();
  await page.getByRole("textbox", { name: "发送给 Racco" }).fill("question");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(
    page.getByText("Fixture question", { exact: true }),
  ).toBeVisible();
  await page.getByRole("radio", { name: "Alpha", exact: true }).check();
  await page.getByRole("button", { name: "提交回答" }).click();
  await expect(
    page.getByText("Fixture: question (answer)", { exact: true }),
  ).toBeVisible();
  await page.getByRole("textbox", { name: "发送给 Racco" }).fill("wait");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByRole("button", { name: "停止生成" })).toBeVisible();
  await page.getByRole("button", { name: "停止生成" }).click();
  await expect(page.locator(".run-state")).toHaveText("已停止");
  await page.getByRole("button", { name: "展开文件侧栏" }).click();
  await page
    .getByRole("button", { name: "文件 other.txt", exact: true })
    .click();
  await expect(page.locator(".file-code-grid")).toContainText("Project beta");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
  await page.getByRole("button", { name: "折叠文件侧栏" }).click();
  await page.getByRole("button", { name: "返回对话历史" }).click();
  await expect(page.locator(".sidebar")).toBeVisible();
});
