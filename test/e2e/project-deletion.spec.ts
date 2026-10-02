import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectEntry, WorktreeCatalog } from "../../src/shared/protocol";
import { runGit } from "../../src/server/worktrees/git";
import { test, expect } from "./fixtures";

for (const action of ["cancel", "keep", "remove"] as const) {
  test(`project deletion ${action} respects the selected disk ownership boundary`, async ({
    page,
    racco,
  }) => {
    const project = racco.projects[0];
    const other = racco.projects[1];
    const created = await page.request.post(
      `/api/projects/${project.projectId}/worktrees`,
      {
        data: { name: "project-delete" },
      },
    );
    expect(created.ok()).toBe(true);
    const catalog: WorktreeCatalog = await created.json();
    const linked = catalog.worktrees.find(
      (entry) => entry.branch === "project-delete",
    )!;
    const unsaved = join(linked.path, "unsaved.txt");
    await writeFile(unsaved, "keep unless explicitly selected\n");
    const deletes: string[] = [];
    page.on("request", (request) => {
      if (
        request.method() === "DELETE" &&
        request.url().includes(`/api/projects/${project.projectId}`)
      )
        deletes.push(request.url());
    });
    await page.goto("/");
    const region = page.getByRole("region", {
      name: `项目 ${project.name}`,
      exact: true,
    });
    await region.locator(".project-tree-header-row").hover();
    await region
      .getByRole("button", { name: `删除项目 ${project.name}`, exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: `删除项目 ${project.name}？`,
    });
    const removeDisk = dialog.getByRole("checkbox", {
      name: /同时删除磁盘上的 Worktree 目录/,
    });
    await expect(removeDisk).not.toBeChecked();
    if (action !== "keep") await removeDisk.check();
    await dialog
      .getByRole("button", {
        name: action === "cancel" ? "取消" : "删除项目",
        exact: true,
      })
      .click();
    await expect(dialog).toHaveCount(0);
    if (action === "cancel") {
      await expect(region).toBeVisible();
      expect(deletes).toEqual([]);
    } else {
      await expect(region).toHaveCount(0);
      expect(deletes).toHaveLength(1);
    }
    const projects: ProjectEntry[] = await (
      await page.request.get("/api/projects")
    ).json();
    expect(
      projects.some((entry) => entry.projectId === project.projectId),
    ).toBe(action === "cancel");
    expect(projects.some((entry) => entry.projectId === other.projectId)).toBe(
      true,
    );
    expect(await readFile(join(other.path, "other.txt"), "utf8")).toBe(
      "Project beta\n",
    );
    expect(await readFile(join(project.path, "README.md"), "utf8")).toContain(
      "Fixture project",
    );
    const worktrees = await runGit(["worktree", "list", "--porcelain"], {
      cwd: project.path,
    });
    if (action === "remove") {
      await expect(access(linked.path)).rejects.toThrow();
      expect(worktrees).not.toContain(`worktree ${linked.path}\n`);
    } else {
      expect(await readFile(unsaved, "utf8")).toBe(
        "keep unless explicitly selected\n",
      );
      expect(worktrees).toContain(`worktree ${linked.path}\n`);
    }
  });
}
