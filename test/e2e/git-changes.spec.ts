import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runGit } from "../../src/server/worktrees/git";
import { test, expect } from "./fixtures";

test("Git dock separates baselines, refreshes same-status content manually and opens its own worktree file", async ({
  page,
  racco,
}) => {
  const alpha = racco.projects[0].path;
  const beta = racco.projects[1].path;
  await writeFile(join(beta, "other.txt"), "staged beta\n");
  await runGit(["add", "other.txt"], { cwd: beta });
  await writeFile(join(beta, "other.txt"), "current beta\n");
  await page.goto(`/session/${racco.sessions[0].sessionId}`);
  await page.getByRole("button", { name: "展开 Git 修改侧栏" }).click();
  const selector = page.getByRole("combobox", {
    name: "Git 修改侧栏 Worktree",
  });
  await expect(selector).toHaveValue(alpha);
  await selector.selectOption(beta);
  await page
    .getByRole("button", { name: "已暂存 other.txt", exact: true })
    .click();
  await expect(page.locator(".git-change-detail .file-diff")).toContainText(
    "+staged beta",
  );
  await page
    .getByRole("button", { name: "未暂存 other.txt", exact: true })
    .click();
  await expect(page.locator(".git-change-detail .file-diff")).toContainText(
    "+current beta",
  );
  await writeFile(join(beta, "other.txt"), "same status updated beta\n");
  await page
    .getByRole("button", { name: "刷新 Git 修改", exact: true })
    .click();
  await expect(page.locator(".git-change-detail .file-diff")).toContainText(
    "+same status updated beta",
    { timeout: 10_000 },
  );
  await page.getByRole("button", { name: "打开当前文件", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "文件侧栏 Worktree" }),
  ).toHaveValue(beta);
  await expect(page.locator(".file-code-grid")).toContainText(
    "same status updated beta",
  );
  await expect(page).toHaveURL(`/session/${racco.sessions[0].sessionId}`);
});

test("transient Git read failures retain the old list and diff with explicit stale status", async ({
  page,
  racco,
}) => {
  await writeFile(
    join(racco.projects[0].path, "README.md"),
    "changed README\n",
  );
  let fail = false;
  await page.route("**/api/worktrees/changes?*", async (route) => {
    if (fail)
      await route.fulfill({
        status: 409,
        json: { message: "工作区正在变化。" },
      });
    else await route.continue();
  });
  await page.goto("/");
  await page.getByRole("button", { name: "展开 Git 修改侧栏" }).click();
  await page
    .getByRole("button", { name: "未暂存 README.md", exact: true })
    .click();
  await expect(page.locator(".git-change-detail .file-diff")).toContainText(
    "+changed README",
  );
  await expect(
    page.getByRole("button", { name: "刷新 Git 修改", exact: true }),
  ).toBeEnabled();
  fail = true;
  await page
    .getByRole("button", { name: "刷新 Git 修改", exact: true })
    .click();
  await expect(page.locator(".git-changes-summary")).toContainText(
    "结果可能已过期",
  );
  await expect(
    page.getByRole("button", { name: "未暂存 README.md", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".git-change-detail .file-diff")).toContainText(
    "+changed README",
  );
  fail = false;
  await page
    .getByRole("button", { name: "刷新 Git 修改", exact: true })
    .click();
  await expect(page.locator(".git-changes-summary")).not.toContainText(
    "结果可能已过期",
  );
});

test("collapsed Git dock stops requests and Escape restores launcher focus", async ({
  page,
  racco,
}) => {
  await writeFile(join(racco.projects[0].path, "new.txt"), "new file\n");
  let reads = 0;
  page.on("request", (request) => {
    if (request.url().includes("/api/worktrees/changes?")) reads++;
  });
  await page.goto("/");
  const launcher = page.getByRole("button", { name: "展开 Git 修改侧栏" });
  await launcher.click();
  await expect(
    page.getByRole("button", { name: "未跟踪 new.txt", exact: true }),
  ).toBeVisible();
  const entered = reads;
  await page.waitForTimeout(3400);
  await page.evaluate(() => {
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(150);
  expect(reads).toBe(entered);
  await page
    .getByRole("button", { name: "未跟踪 new.txt", exact: true })
    .click();
  await expect(page.locator(".git-change-detail .file-diff")).toContainText(
    "new file",
  );
  expect(reads).toBe(entered);
  await page
    .getByRole("combobox", { name: "Git 修改侧栏 Worktree" })
    .press("Escape");
  await expect(launcher).toBeFocused();
  const previous = reads;
  await page.waitForTimeout(3400);
  expect(reads).toBe(previous);
  await launcher.click();
  await expect(
    page.getByRole("button", { name: "刷新 Git 修改", exact: true }),
  ).toBeEnabled();
  expect(reads).toBe(previous + 1);
});

test("unselected Git details remain empty and mobile launchers scroll inside their control", async ({
  page,
  racco,
}) => {
  await writeFile(join(racco.projects[0].path, "new.txt"), "new file\n");
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto("/");
  const rail = page.getByRole("navigation", { name: "项目工具" });
  const dimensions = await rail.evaluate((element) => ({
    client: element.clientWidth,
    scroll: element.scrollWidth,
    right: element.getBoundingClientRect().right,
  }));
  expect(dimensions.scroll).toBeGreaterThan(dimensions.client);
  expect(dimensions.right).toBeLessThanOrEqual(320);
  await rail.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  const changes = page.getByRole("button", { name: "展开 Git 修改侧栏" });
  const railBox = (await rail.boundingBox())!;
  const buttonBox = (await changes.boundingBox())!;
  expect(buttonBox.x).toBeGreaterThanOrEqual(railBox.x);
  expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(
    railBox.x + railBox.width,
  );
  await changes.click();
  await expect(changes).toHaveAttribute("aria-expanded", "true");
  await expect(
    page.getByRole("button", { name: "未跟踪 new.txt", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".git-change-detail")).toBeEmpty();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("reopening during a pending detail read can recover with manual refresh after a list error", async ({
  page,
  racco,
}) => {
  await writeFile(join(racco.projects[0].path, "new.txt"), "new file\n");
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let detailStarted = false;
  let failList = false;
  await page.route("**/api/worktrees/change-diff?*", async (route) => {
    detailStarted = true;
    await held;
    await route.continue().catch(() => {});
  });
  await page.route("**/api/worktrees/changes?*", async (route) => {
    if (failList)
      await route.fulfill({ status: 409, json: { message: "读取繁忙" } });
    else await route.continue();
  });
  await page.goto("/");
  const launcher = page.getByRole("button", { name: "展开 Git 修改侧栏" });
  await launcher.click();
  await page
    .getByRole("button", { name: "未跟踪 new.txt", exact: true })
    .click();
  await expect.poll(() => detailStarted).toBe(true);
  await launcher.click();
  failList = true;
  await launcher.click();
  await expect(page.locator(".git-changes-summary")).toContainText("读取繁忙");
  const refresh = page.getByRole("button", {
    name: "刷新 Git 修改",
    exact: true,
  });
  await expect(refresh).toBeEnabled();
  release!();
  failList = false;
  await refresh.click();
  await expect(page.locator(".git-change-detail .file-diff")).toContainText(
    "new file",
  );
});

test("Git dock supports narrow screens and does not show clean state for an unavailable repository", async ({
  page,
  racco,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "展开 Git 修改侧栏" }).click();
  await expect(page.locator(".git-change-list")).toContainText("工作区干净");
  await page.route("**/api/worktrees/changes?*", (route) =>
    route.fulfill({ status: 422, json: { message: "不是 Git 工作区。" } }),
  );
  await page
    .getByRole("combobox", { name: "Git 修改侧栏 Worktree" })
    .selectOption(racco.projects[1].path);
  await expect(page.locator(".git-changes-summary")).toContainText(
    "不是 Git 工作区",
  );
  await expect(page.locator(".git-change-list")).not.toContainText(
    "工作区干净",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("a file chosen during a failing list refresh still gets one detail read", async ({
  page,
  racco,
}) => {
  await writeFile(join(racco.projects[0].path, "a.txt"), "file A\n");
  await writeFile(join(racco.projects[0].path, "b.txt"), "file B\n");
  let hold = false;
  let waiting = false;
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let listReads = 0;
  let bReads = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/worktrees/changes") listReads++;
    if (
      url.pathname === "/api/worktrees/change-diff" &&
      url.searchParams.get("file") === "b.txt"
    )
      bReads++;
  });
  await page.route("**/api/worktrees/changes?*", async (route) => {
    if (!hold) {
      await route.continue();
      return;
    }
    waiting = true;
    await held;
    await route.fulfill({ status: 409, json: { message: "列表读取失败" } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "展开 Git 修改侧栏" }).click();
  await page.getByRole("button", { name: "未跟踪 a.txt", exact: true }).click();
  await expect(page.locator(".git-change-detail .file-diff")).toContainText(
    "file A",
  );
  hold = true;
  await page
    .getByRole("button", { name: "刷新 Git 修改", exact: true })
    .click();
  await expect.poll(() => waiting).toBe(true);
  await page.getByRole("button", { name: "未跟踪 b.txt", exact: true }).click();
  expect(bReads).toBe(0);
  release!();
  await expect(page.locator(".git-changes-summary")).toContainText(
    "列表读取失败",
  );
  await expect(page.locator(".git-change-detail .file-diff")).toContainText(
    "file B",
  );
  expect(bReads).toBe(1);
  expect(listReads).toBe(2);
});
