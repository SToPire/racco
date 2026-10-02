import type { WorktreeCatalog } from "../../src/shared/protocol";
import { test, expect } from "./fixtures";

test("file tabs follow worktrees and deleted worktrees release their browsing state", async ({
  page,
  racco,
}) => {
  const project = racco.projects[0]!;
  const create = async () => {
    const response = await page.request.post(
      `/api/projects/${project.projectId}/worktrees`,
      { data: { name: "tab-state" } },
    );
    expect(response.ok()).toBe(true);
    const catalog: WorktreeCatalog = await response.json();
    return catalog.worktrees.find((entry) => entry.branch === "tab-state")!;
  };
  const worktree = await create();
  await page.goto(`/session/${racco.sessions[0]!.sessionId}`);
  await page.getByRole("button", { name: "展开文件侧栏" }).click();
  const selector = page.getByRole("combobox", { name: "文件侧栏 Worktree" });
  await selector.selectOption(worktree.path);
  await page
    .getByRole("button", { name: "文件 README.md", exact: true })
    .click();
  await page.getByRole("tab", { name: "Files", exact: true }).click();
  await page
    .getByRole("button", { name: "文件 unsafe.html", exact: true })
    .click();
  await selector.selectOption(project.path);
  await expect(
    page.getByRole("tab", { name: "unsafe.html", exact: true }),
  ).toHaveCount(0);
  await selector.selectOption(worktree.path);
  await expect(
    page.getByRole("tab", { name: "README.md", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("tab", { name: "unsafe.html", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByLabel("文件内容 unsafe.html", { exact: true }),
  ).toBeVisible();
  await selector.selectOption(project.path);
  const removed = await page.request.delete(
    `/api/worktrees?${new URLSearchParams({ projectId: project.projectId, path: worktree.path, deleteBranch: "true" })}`,
  );
  expect(removed.ok()).toBe(true);
  await expect(
    selector.locator("option", { hasText: "tab-state" }),
  ).toHaveCount(0);
  const recreated = await create();
  expect(recreated.path).toBe(worktree.path);
  await expect(
    selector.locator("option", { hasText: "tab-state" }),
  ).toHaveCount(1);
  await selector.selectOption(recreated.path);
  await expect(
    page.getByRole("tab", { name: "Files", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("tab", { name: "README.md", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("tab", { name: "unsafe.html", exact: true }),
  ).toHaveCount(0);
});
