import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorktreeCatalog } from "../../src/shared/protocol";
import { runGit } from "../../src/server/worktrees/git";
import { test, expect } from "./fixtures";

test("manual Dock selection survives an open session and new sessions follow their project", async ({
  page,
  racco,
}) => {
  await page.goto(`/session/${racco.sessions[0].sessionId}`);
  await expect(
    page.locator(".session-view:not([hidden]) .session-title-line h1"),
  ).toContainText("[Fixture]");
  await page.getByRole("button", { name: "展开文件侧栏" }).click();
  const selector = page.getByRole("combobox", { name: "文件侧栏 Worktree" });
  await selector.selectOption(racco.projects[1].path);
  await expect(selector).toHaveValue(racco.projects[1].path);
  await page
    .getByRole("button", { name: "文件 other.txt", exact: true })
    .click();
  await expect(page.locator(".file-code-grid")).toContainText("Project beta");
  await expect(page).toHaveURL(`/session/${racco.sessions[0].sessionId}`);
  await page
    .getByRole("region", { name: "项目 beta", exact: true })
    .locator(".project-tree-header-row")
    .hover();
  await page
    .getByRole("button", { name: "在项目 beta 中新建对话", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "项目", exact: true }),
  ).toHaveText("beta");
  await expect(selector).toHaveValue(racco.projects[1].path);
  await page.getByRole("button", { name: "项目", exact: true }).click();
  await page.getByRole("option", { name: "alpha", exact: true }).click();
  await expect(selector).toHaveValue(racco.projects[0].path);
});

test("creating a linked worktree selects it for the composer and Dock", async ({
  page,
  racco,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "新建 Worktree…", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "新 Worktree 名称" })
    .fill("feature/test");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Worktree", exact: true }),
  ).toContainText("feature-test");
  await page.getByRole("button", { name: "展开文件侧栏" }).click();
  const selector = page.getByRole("combobox", { name: "文件侧栏 Worktree" });
  await expect(selector).toHaveValue(/feature-test$/);
  await page
    .getByRole("textbox", { name: "首条任务" })
    .fill("worktree session");
  await page.getByRole("button", { name: "新建并发送", exact: true }).click();
  await expect(
    page.getByText("Fixture: worktree session", { exact: true }),
  ).toBeVisible();
  const sessions = await (await page.request.get("/api/sessions")).json();
  const created = sessions.find((session: { sessionId: string }) =>
    page.url().endsWith(session.sessionId),
  );
  expect(created.projectId).toBe(racco.projects[0].projectId);
  expect(created.cwd).toBe(await selector.inputValue());
});

test("dirty worktree removal requires a second confirmation even when Git hides untracked files", async ({
  page,
  racco,
}) => {
  const project = racco.projects[0];
  const response = await page.request.post(
    `/api/projects/${project.projectId}/worktrees`,
    { data: { name: "dirty" } },
  );
  expect(response.ok()).toBe(true);
  const catalog: WorktreeCatalog = await response.json();
  const worktree = catalog.worktrees.find((entry) => entry.branch === "dirty")!;
  const file = join(worktree.path, "untracked.txt");
  await writeFile(file, "keep until confirmed\n");
  await runGit(["config", "status.showUntrackedFiles", "no"], {
    cwd: project.path,
  });
  await page.goto("/");
  let acceptDirty = false;
  const dialogs: string[] = [];
  page.on("dialog", async (dialog) => {
    dialogs.push(dialog.message());
    if (dialog.message().includes("未提交") && !acceptDirty)
      await dialog.dismiss();
    else await dialog.accept();
  });
  const row = page.locator(".worktree-row-wrap").filter({
    has: page.getByRole("button", {
      name: "删除 Worktree dirty",
      exact: true,
    }),
  });
  await row.hover();
  await row
    .getByRole("button", { name: "删除 Worktree dirty", exact: true })
    .click();
  const confirmation = page.getByRole("dialog", {
    name: "删除 Worktree dirty？",
  });
  await expect(
    confirmation.getByRole("checkbox", {
      name: "同时删除本地分支 dirty",
    }),
  ).not.toBeChecked();
  await confirmation
    .getByRole("button", { name: "删除 Worktree", exact: true })
    .click();
  await expect.poll(() => dialogs.length).toBe(1);
  expect(await readFile(file, "utf8")).toBe("keep until confirmed\n");
  acceptDirty = true;
  await row.hover();
  await row
    .getByRole("button", { name: "删除 Worktree dirty", exact: true })
    .click();
  await confirmation
    .getByRole("button", { name: "删除 Worktree", exact: true })
    .click();
  await expect(row).toHaveCount(0);
  expect(dialogs).toHaveLength(2);
  await expect(access(worktree.path)).rejects.toThrow();
  expect(
    (await runGit(["branch", "--list", "dirty"], { cwd: project.path })).trim(),
  ).not.toBe("");
});

test("worktree deletion can explicitly remove its local branch", async ({
  page,
  racco,
}) => {
  const project = racco.projects[0];
  const response = await page.request.post(
    `/api/projects/${project.projectId}/worktrees`,
    { data: { name: "remove-with-worktree" } },
  );
  expect(response.ok()).toBe(true);
  const catalog: WorktreeCatalog = await response.json();
  const worktree = catalog.worktrees.find(
    (entry) => entry.branch === "remove-with-worktree",
  )!;

  await page.goto("/");
  const row = page.locator(".worktree-row-wrap").filter({
    has: page.getByRole("button", {
      name: "删除 Worktree remove-with-worktree",
      exact: true,
    }),
  });
  await row.hover();
  await row
    .getByRole("button", {
      name: "删除 Worktree remove-with-worktree",
      exact: true,
    })
    .click();
  const confirmation = page.getByRole("dialog", {
    name: "删除 Worktree remove-with-worktree？",
  });
  await confirmation
    .getByRole("checkbox", {
      name: "同时删除本地分支 remove-with-worktree",
    })
    .check();
  await confirmation
    .getByRole("button", { name: "删除 Worktree", exact: true })
    .click();

  await expect(row).toHaveCount(0);
  await expect(access(worktree.path)).rejects.toThrow();
  expect(
    (
      await runGit(["branch", "--list", "remove-with-worktree"], {
        cwd: project.path,
      })
    ).trim(),
  ).toBe("");
});

test("a degraded refresh keeps worktrees visible and reports the error beside the project", async ({
  page,
  racco,
}) => {
  const project = racco.projects[0];
  const created = await page.request.post(
    `/api/projects/${project.projectId}/worktrees`,
    { data: { name: "kept" } },
  );
  const catalog: WorktreeCatalog = await created.json();
  await page.goto(`/session/${racco.sessions[0].sessionId}`);
  await expect(
    page.locator(".session-view:not([hidden]) .session-title-line h1"),
  ).toContainText("[Fixture]");
  await page.route("**/api/worktrees/refresh?*", (route) =>
    route.fulfill({ json: { ...catalog, degradedReason: "Git 暂不可用" } }),
  );
  const refresh = page.getByRole("button", {
    name: "刷新 alpha 的 Worktree 列表",
    exact: true,
  });
  await page
    .getByRole("region", { name: "项目 alpha", exact: true })
    .locator(".project-tree-header-row")
    .hover();
  await refresh.click();
  await expect(page.locator(".sidebar").getByRole("alert")).toHaveText(
    "Git 暂不可用",
  );
  await expect(
    page.getByRole("button", { name: "删除 Worktree kept", exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByText("已失效的 Worktree", { exact: true }),
  ).toHaveCount(0);
  await page.unroute("**/api/worktrees/refresh?*");
  await refresh.click();
  await expect(page.locator(".sidebar").getByRole("alert")).toHaveCount(0);
});
