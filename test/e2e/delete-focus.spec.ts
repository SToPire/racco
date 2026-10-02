import { test, expect } from "./fixtures";

for (const kind of ["project", "worktree"] as const) {
  test(`opening ${kind} deletion and pressing Enter cancels without a delete request`, async ({
    page,
    racco,
  }) => {
    const project = racco.projects[0];
    if (kind === "worktree") {
      const created = await page.request.post(
        `/api/projects/${project.projectId}/worktrees`,
        { data: { name: "keyboard-cancel" } },
      );
      expect(created.ok()).toBe(true);
    }
    await page.goto("/");
    const deletes: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "DELETE") deletes.push(request.url());
    });
    const trigger = page.getByRole("button", {
      name:
        kind === "project"
          ? `删除项目 ${project.name}`
          : "删除 Worktree keyboard-cancel",
      exact: true,
    });
    await trigger.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", {
      name:
        kind === "project"
          ? `删除项目 ${project.name}？`
          : "删除 Worktree keyboard-cancel？",
    });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "取消", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(dialog).not.toBeVisible();
    await expect(trigger).toBeVisible();
    expect(deletes).toEqual([]);
    const projects = await (await page.request.get("/api/projects")).json();
    expect(
      projects.some(
        (entry: { projectId: string }) => entry.projectId === project.projectId,
      ),
    ).toBe(true);
  });
}
