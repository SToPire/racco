import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page, Response } from "@playwright/test";
import { GitHistoryPageSchema } from "../../src/shared/git-history";
import { runGit } from "../../src/server/worktrees/git";
import { test, expect } from "./fixtures";

async function commitFile(
  cwd: string,
  file: string,
  text: string,
  title: string,
) {
  await writeFile(join(cwd, file), text);
  await runGit(["add", "--", file], { cwd });
  await runGit(["-c", "core.hooksPath=/dev/null", "commit", "-qm", title], {
    cwd,
  });
  return (await runGit(["rev-parse", "HEAD"], { cwd })).trim();
}

async function seedHistory(cwd: string, count: number) {
  const ids: string[] = [];
  for (let i = 1; i <= count; i++) {
    ids.push(
      await commitFile(
        cwd,
        "history.txt",
        `committed version ${i}\n`,
        `History ${String(i).padStart(2, "0")}`,
      ),
    );
  }
  return ids;
}

function historyResponse(page: Page, appended = false) {
  return page.waitForResponse((response: Response) => {
    const url = new URL(response.url());
    return (
      url.pathname === "/api/worktrees/commits" &&
      url.searchParams.has("cursor") === appended &&
      response.status() === 200
    );
  });
}

async function openHistory(page: Page) {
  const response = historyResponse(page);
  await page.getByRole("button", { name: "展开提交历史", exact: true }).click();
  return GitHistoryPageSchema.parse(await (await response).json());
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`history is initially folded and appends within its own scroll area at ${viewport.width}px`, async ({
    page,
    racco,
  }) => {
    const cwd = racco.projects[0].path;
    const ids = await seedHistory(cwd, 36);
    await runGit(["tag", "v1.0.0"], { cwd });
    await runGit(["branch", "release"], { cwd });
    await runGit(["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd });
    await runGit(["tag", "earlier-release", ids[18]], { cwd });
    await writeFile(
      join(racco.projects[0].path, "README.md"),
      "dirty README\n",
    );
    await page.setViewportSize(viewport);
    let historyReads = 0;
    let changesReads = 0;
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path === "/api/worktrees/commits") historyReads++;
      if (path === "/api/worktrees/changes") changesReads++;
    });
    await page.goto("/");
    await page.getByRole("button", { name: "展开 Git 修改侧栏" }).click();
    const dirty = page.getByRole("button", {
      name: "Unstaged README.md",
      exact: true,
    });
    await expect(dirty).toBeVisible();
    await expect(
      page.getByRole("button", { name: "展开提交历史", exact: true }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(historyReads).toBe(0);

    const first = await openHistory(page);
    expect(first.commits).toHaveLength(15);
    expect(first.scope).toBe("current");
    const list = page.locator(".git-history-list");
    await expect(list).toBeVisible();
    await expect(dirty).toBeVisible();
    const firstRow = list.locator(".git-history-row").first();
    const rowBox = (await firstRow.boundingBox())!;
    const svgBox = (await firstRow.locator("svg").boundingBox())!;
    expect(rowBox.height).toBe(60);
    await expect(firstRow.locator(".git-history-row-title")).toHaveText(
      "History 36",
    );
    await expect(firstRow.locator("code")).toHaveText(
      first.commits[0].oid.slice(0, 8),
    );
    await expect(firstRow.locator(".git-history-ref")).toHaveText(
      first.commits[0].refs.map((ref) => ref.name),
    );
    const refsBox = (await firstRow
      .locator(".git-history-row-refs")
      .boundingBox())!;
    expect(refsBox.y).toBeCloseTo(rowBox.y + 32, 1);
    expect(refsBox.y + refsBox.height).toBeLessThanOrEqual(
      rowBox.y + rowBox.height,
    );
    await expect(firstRow).not.toHaveAttribute("title", /Refs:/);
    await expect(firstRow).toHaveAttribute("title", /Author: /);
    await expect(firstRow).toHaveAttribute("title", /Author Date: /);
    await expect(firstRow).toHaveAttribute("title", /Commit Date: /);
    await expect(page.locator(".git-history-region")).not.toContainText(
      /已加载 \d+ 条/,
    );
    expect(await firstRow.getAttribute("title")).toContain(
      first.commits[0].oid,
    );
    const idBox = (await firstRow.locator("code").boundingBox())!;
    expect(idBox.x + idBox.width).toBeCloseTo(rowBox.x + rowBox.width - 8, 1);
    expect(idBox.y + idBox.height / 2).toBeCloseTo(rowBox.y + 16, 1);
    expect(svgBox.height).toBeCloseTo(rowBox.height, 1);
    const secondSvg = (await list
      .locator(".git-history-row svg")
      .nth(1)
      .boundingBox())!;
    expect(secondSvg.y).toBeCloseTo(svgBox.y + svgBox.height, 1);
    expect(secondSvg.height).toBe(32);
    await expect(firstRow.locator("svg circle")).toHaveAttribute("cy", "16");
    const refStrip = firstRow.locator(".git-history-row-refs");
    await refStrip.evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
    });
    await expect(firstRow.locator(".git-history-ref").last()).toBeInViewport();
    expect(historyReads).toBe(1);
    const bounds = await list.evaluate((element) => ({
      height: element.clientHeight,
      scroll: element.scrollHeight,
      right: element.getBoundingClientRect().right,
      top: element.getBoundingClientRect().top,
    }));
    expect(bounds.height).toBeGreaterThan(60);
    expect(bounds.height).toBeLessThan(viewport.height / 2);
    expect(bounds.scroll).toBeGreaterThan(bounds.height);
    expect(bounds.right).toBeLessThanOrEqual(viewport.width);
    expect(bounds.top).toBeGreaterThan((await dirty.boundingBox())!.y);
    const initialChanges = changesReads;

    const next = historyResponse(page, true);
    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const second = GitHistoryPageSchema.parse(await (await next).json());
    expect(second.commits).toHaveLength(15);
    expect(second.snapshotId).toBe(first.snapshotId);
    expect(
      new Set([...first.commits, ...second.commits].map((commit) => commit.oid))
        .size,
    ).toBe(30);
    await expect(list.getByRole("listitem").first()).toHaveAttribute(
      "aria-setsize",
      "30",
    );
    expect(changesReads).toBe(initialChanges);
    const scroll = await list.evaluate((element) => element.scrollTop);
    expect(scroll).toBeGreaterThan(0);
    const beforeReopen = historyReads;
    await page
      .getByRole("button", { name: "折叠提交历史", exact: true })
      .click();
    await expect(dirty).toBeVisible();
    await page
      .getByRole("button", { name: "展开提交历史", exact: true })
      .click();
    await expect
      .poll(() => list.evaluate((element) => element.scrollTop))
      .toBeCloseTo(scroll, 0);
    await page.waitForTimeout(150);
    expect(historyReads).toBe(beforeReopen);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });
}

test("commit ID copying uses the full hash without opening details and reports clipboard failures", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await page.getByRole("button", { name: "展开 Git 修改侧栏" }).click();
  const history = await openHistory(page);
  const oid = history.commits[0].oid;
  const copy = page.getByRole("button", {
    name: `Copy full commit ID ${oid.slice(0, 8)}`,
    exact: true,
  });
  await copy.click();
  await expect(copy).toHaveText("Copied");
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(oid);
  await expect(page.locator(".git-commit-detail")).toHaveCount(0);
  await expect(page.locator(".git-history-list")).toBeVisible();

  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, "writeText", {
      configurable: true,
      value: async () => {
        throw new DOMException(
          "Clipboard permission denied",
          "NotAllowedError",
        );
      },
    });
  });
  await copy.press("Enter");
  await expect(copy).toHaveText("Failed");
  await expect(copy).toHaveAttribute(
    "title",
    "Copy failed. Click to try again.",
  );
  await page.evaluate(() => {
    Reflect.deleteProperty(navigator.clipboard, "writeText");
  });
  await copy.press("Space");
  await expect(copy).toHaveText("Copied");
  await expect(page.locator(".git-commit-detail")).toHaveCount(0);
  await page
    .getByRole("button", { name: `提交 ${oid.slice(0, 8)}`, exact: false })
    .click();
  await expect(page.locator(".git-commit-detail")).toBeVisible();
});

test("scroll pagination keeps its original history until explicit refresh", async ({
  page,
  racco,
}) => {
  const cwd = racco.projects[0].path;
  const ids = await seedHistory(cwd, 25);
  await page.goto("/");
  await page.getByRole("button", { name: "展开 Git 修改侧栏" }).click();
  const first = await openHistory(page);
  expect(first.head).toBe(ids.at(-1));
  const newHead = await commitFile(
    cwd,
    "history.txt",
    "new head\n",
    "New head",
  );
  const next = historyResponse(page, true);
  await page.locator(".git-history-list").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const second = GitHistoryPageSchema.parse(await (await next).json());
  expect(second.snapshotId).toBe(first.snapshotId);
  expect(second.head).toBe(first.head);
  expect(second.nextCursor).toBeNull();
  expect(second.commits.some((commit) => commit.oid === newHead)).toBe(false);
  const refreshed = historyResponse(page);
  await page.getByRole("button", { name: "刷新提交历史", exact: true }).click();
  const current = GitHistoryPageSchema.parse(await (await refreshed).json());
  expect(current.snapshotId).not.toBe(first.snapshotId);
  expect(current.head).toBe(newHead);
  await expect(
    page.getByRole("button", { name: /提交 .* New head/ }),
  ).toBeVisible();
});

test("commit diffs use committed content and preserve current-change selection", async ({
  page,
  racco,
}) => {
  const cwd = racco.projects[0].path;
  await seedHistory(cwd, 3);
  await writeFile(join(cwd, "history.txt"), "working copy only\n");
  await page.goto("/");
  await page.getByRole("button", { name: "展开 Git 修改侧栏" }).click();
  const dirty = page.getByRole("button", {
    name: "Unstaged history.txt",
    exact: true,
  });
  await dirty.click();
  await expect(page.locator(".git-change-detail .file-diff")).toContainText(
    "+working copy only",
  );
  await openHistory(page);
  await page.getByRole("button", { name: /提交 .* History 03/ }).click();
  await page
    .getByRole("button", { name: "提交文件 M history.txt", exact: true })
    .click();
  const patch = page.locator(".git-commit-diff .file-diff");
  await expect(patch).toContainText("-committed version 2");
  await expect(patch).toContainText("+committed version 3");
  await expect(patch).not.toContainText("working copy only");
  await expect(dirty).toHaveAttribute("aria-pressed", "true");

  await writeFile(join(cwd, "history.txt"), "updated working copy\n");
  await page
    .getByRole("button", { name: "刷新 Git 修改", exact: true })
    .click();
  await expect(page.locator(".git-change-detail .file-diff")).toContainText(
    "+updated working copy",
  );
  await expect(patch).toContainText("+committed version 3");
  await page.getByRole("button", { name: "返回提交历史", exact: true }).click();
  await expect(page.locator(".git-history-list")).toBeVisible();
  await expect(dirty).toHaveAttribute("aria-pressed", "true");
});

test("merge details compare the selected actual parent", async ({
  page,
  racco,
}) => {
  const cwd = racco.projects[0].path;
  const branch = (
    await runGit(["symbolic-ref", "--short", "HEAD"], { cwd })
  ).trim();
  await runGit(["checkout", "-qb", "topic"], { cwd });
  const topic = await commitFile(cwd, "topic.txt", "topic\n", "Topic commit");
  await runGit(["checkout", "-q", branch], { cwd });
  await commitFile(cwd, "main.txt", "main\n", "Main commit");
  await runGit(
    [
      "-c",
      "core.hooksPath=/dev/null",
      "merge",
      "--no-ff",
      "-qm",
      "Merge topic",
      "topic",
    ],
    { cwd },
  );
  await page.goto("/");
  await page.getByRole("button", { name: "展开 Git 修改侧栏" }).click();
  const first = await openHistory(page);
  expect(first.commits[0].parents).toHaveLength(2);
  await page.getByRole("button", { name: /提交 .* Merge topic/ }).click();
  await expect(
    page.getByRole("button", { name: "提交文件 A topic.txt", exact: true }),
  ).toBeVisible();
  await page.getByRole("combobox", { name: "比较父提交" }).selectOption(topic);
  await expect(
    page.getByRole("button", { name: "提交文件 A main.txt", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "提交文件 A topic.txt", exact: true }),
  ).toHaveCount(0);
});

test("failed scroll reads stop until explicit retry and do not lose their cursor", async ({
  page,
  racco,
}) => {
  await seedHistory(racco.projects[0].path, 32);
  let fail = true;
  const cursors: string[] = [];
  await page.route("**/api/worktrees/commits?*", async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    if (cursor) {
      cursors.push(cursor);
      if (fail) {
        await route.fulfill({
          status: 409,
          json: { message: "测试读取繁忙", code: "GIT_BUSY" },
        });
        return;
      }
    }
    await route.continue();
  });
  await page.goto("/");
  await page.getByRole("button", { name: "展开 Git 修改侧栏" }).click();
  const first = await openHistory(page);
  const list = page.locator(".git-history-list");
  await list.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const history = page.locator(".git-history-region");
  await expect(history).toContainText("测试读取繁忙");
  await list.evaluate((element) => {
    element.scrollTop -= 40;
  });
  await list.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await page.waitForTimeout(150);
  expect(cursors).toEqual([first.nextCursor]);
  fail = false;
  const next = historyResponse(page, true);
  await history.getByRole("button", { name: /重试/ }).click();
  const second = GitHistoryPageSchema.parse(await (await next).json());
  expect(second.commits).toHaveLength(15);
  expect(cursors).toEqual([first.nextCursor, first.nextCursor]);
});

test("switching worktrees resets history to folded and ignores a late old request", async ({
  page,
  racco,
}) => {
  const alpha = racco.projects[0].path;
  const beta = racco.projects[1].path;
  await seedHistory(alpha, 20);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = false;
  await page.route("**/api/worktrees/commits?*", async (route) => {
    if (new URL(route.request().url()).searchParams.get("path") === alpha) {
      started = true;
      await held;
    }
    await route.continue().catch(() => {});
  });
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "展开 Git 修改侧栏" }).click();
    await page
      .getByRole("button", { name: "展开提交历史", exact: true })
      .click();
    await expect.poll(() => started).toBe(true);
    await page
      .getByRole("combobox", { name: "Git 修改侧栏 Worktree" })
      .selectOption(beta);
    await expect(
      page.getByRole("button", { name: "展开提交历史", exact: true }),
    ).toHaveAttribute("aria-expanded", "false");
    release();
    const current = await openHistory(page);
    expect(current.path).toBe(beta);
    expect(current.commits).toHaveLength(1);
    await expect(page.locator(".git-history-region")).not.toContainText(
      "History 20",
    );
  } finally {
    release();
  }
});

test("all-branch graphs preserve shallow boundaries even when their parent appears first", async ({
  page,
  racco,
}) => {
  const cwd = racco.projects[0].path;
  const parent = (await runGit(["rev-parse", "HEAD"], { cwd })).trim();
  const tree = (await runGit(["rev-parse", "HEAD^{tree}"], { cwd })).trim();
  const child = execFileSync("git", ["commit-tree", tree, "-p", parent], {
    cwd,
    encoding: "utf8",
    input: "Shallow child\n",
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2026-10-01T00:00:00+00:00",
      GIT_COMMITTER_DATE: "2026-10-01T00:00:00+00:00",
    },
  }).trim();
  await runGit(["update-ref", "refs/heads/visible-parent", parent], { cwd });
  await runGit(["update-ref", "HEAD", child], { cwd });
  await writeFile(join(cwd, ".git", "shallow"), child + "\n");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByRole("button", { name: "展开 Git 修改侧栏" }).click();
  const current = await openHistory(page);
  expect(current.commits).toHaveLength(1);
  const response = historyResponse(page);
  await page
    .getByRole("combobox", { name: "提交历史范围" })
    .selectOption("all");
  const all = GitHistoryPageSchema.parse(await (await response).json());
  expect(all.commits.map((commit) => commit.oid)).toEqual([parent, child]);
  await expect(
    page.getByRole("button", { name: /提交 .* Shallow child/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("list", { name: "历史提交" }).getByRole("listitem").first(),
  ).toHaveAttribute("aria-setsize", "2");
  expect(errors).toEqual([]);
});

test("growing a visible history pane fills the viewport without prefetching on restoration", async ({
  page,
  racco,
}) => {
  await seedHistory(racco.projects[0].path, 22);
  await page.setViewportSize({ width: 1440, height: 1100 });
  let requests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/worktrees/commits")
      requests++;
  });
  await page.goto("/");
  await page.getByRole("button", { name: "展开 Git 修改侧栏" }).click();
  await openHistory(page);
  const next = historyResponse(page, true);
  await page.getByRole("separator", { name: "调整提交历史高度" }).press("End");
  expect(
    GitHistoryPageSchema.parse(await (await next).json()).commits,
  ).toHaveLength(8);
  await expect(
    page.getByRole("list", { name: "历史提交" }).getByRole("listitem").first(),
  ).toHaveAttribute("aria-setsize", "23");
  await expect
    .poll(() =>
      page
        .locator(".git-history-list")
        .evaluate((element) => element.scrollHeight > element.clientHeight),
    )
    .toBe(true);
  const before = requests;
  await page.getByRole("button", { name: "折叠提交历史", exact: true }).click();
  await page.getByRole("button", { name: "展开提交历史", exact: true }).click();
  await page.waitForTimeout(150);
  expect(requests).toBe(before);
});

test("returning from a canceled file diff clears its loading state", async ({
  page,
}) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = false;
  await page.route("**/api/worktrees/commit-diff?*", async (route) => {
    started = true;
    await held;
    await route.continue().catch(() => {});
  });
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "展开 Git 修改侧栏" }).click();
    await openHistory(page);
    await page.getByRole("button", { name: /提交 .* fixture/ }).click();
    await page
      .getByRole("button", { name: "提交文件 A README.md", exact: true })
      .click();
    await expect.poll(() => started).toBe(true);
    await expect(page.locator(".git-commit-detail")).toContainText(
      "正在读取提交差异",
    );
    await page
      .getByRole("button", { name: "返回提交文件", exact: true })
      .click();
    release();
    await expect(
      page.locator(".git-commit-detail").getByText(/^正在读取/),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "提交文件 A README.md", exact: true })
      .click();
    await expect(page.locator(".git-commit-diff .file-diff")).toContainText(
      "Fixture project",
    );
  } finally {
    release();
  }
});

test("detail contention retries preserve loaded history and its scroll anchor", async ({
  page,
  racco,
}) => {
  await seedHistory(racco.projects[0].path, 36);
  let historyReads = 0;
  let fail = true;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/worktrees/commits")
      historyReads++;
  });
  await page.route("**/api/worktrees/commit-diff?*", async (route) => {
    if (fail) {
      fail = false;
      await route.fulfill({
        status: 409,
        json: { message: "一次性读取繁忙", code: "GIT_BUSY" },
      });
    } else await route.continue();
  });
  await page.goto("/");
  await page.getByRole("button", { name: "展开 Git 修改侧栏" }).click();
  await openHistory(page);
  const next = historyResponse(page, true);
  const list = page.locator(".git-history-list");
  await list.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await next;
  await expect(
    page.getByRole("list", { name: "历史提交" }).getByRole("listitem").first(),
  ).toHaveAttribute("aria-setsize", "30");
  await list.evaluate((element) => {
    element.scrollTop = 250;
  });
  const reads = historyReads;
  await page.getByRole("button", { name: /提交 .* History 27/ }).click();
  await page
    .getByRole("button", { name: "提交文件 M history.txt", exact: true })
    .click();
  const detail = page.locator(".git-commit-detail");
  await expect(detail).toContainText("一次性读取繁忙");
  await expect(
    page.locator(".git-history-region").getByRole("button", { name: /重试/ }),
  ).toHaveCount(1);
  await detail.getByRole("button", { name: "重试读取", exact: true }).click();
  await expect(page.locator(".git-commit-diff .file-diff")).toContainText(
    "+committed version 27",
  );
  await page.getByRole("button", { name: "返回提交历史", exact: true }).click();
  await expect(page.locator(".git-history-region")).not.toContainText(
    "一次性读取繁忙",
  );
  await expect(
    page.getByRole("list", { name: "历史提交" }).getByRole("listitem").first(),
  ).toHaveAttribute("aria-setsize", "30");
  await expect
    .poll(() => list.evaluate((element) => element.scrollTop))
    .toBeCloseTo(250, 0);
  expect(historyReads).toBe(reads);
  const last = historyResponse(page, true);
  await list.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  expect(
    GitHistoryPageSchema.parse(await (await last).json()).commits,
  ).toHaveLength(7);
});

test("server capacity limits keep prior history readable without futile retry", async ({
  page,
  racco,
}) => {
  await seedHistory(racco.projects[0].path, 25);
  let appendRequests = 0;
  await page.route("**/api/worktrees/commits?*", async (route) => {
    if (new URL(route.request().url()).searchParams.has("cursor")) {
      appendRequests++;
      await route.fulfill({
        status: 413,
        json: { message: "服务端历史容量已达上限", code: "HISTORY_LIMIT" },
      });
    } else await route.continue();
  });
  await page.goto("/");
  await page.getByRole("button", { name: "展开 Git 修改侧栏" }).click();
  await openHistory(page);
  const list = page.locator(".git-history-list");
  await list.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const history = page.locator(".git-history-region");
  await expect(history).toContainText("服务端历史容量已达上限");
  await expect(history).not.toContainText("已到历史末尾");
  await expect(history.getByRole("button", { name: /重试/ })).toHaveCount(0);
  await expect(
    page.getByRole("list", { name: "历史提交" }).getByRole("listitem").first(),
  ).toHaveAttribute("aria-setsize", "15");
  await list.evaluate((element) => {
    element.scrollTop -= 50;
  });
  await list.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await page.waitForTimeout(150);
  expect(appendRequests).toBe(1);
  await page.getByRole("button", { name: /提交 .* History 12/ }).click();
  await expect(
    page.getByRole("button", { name: "提交文件 M history.txt", exact: true }),
  ).toBeVisible();
});

test("unsupported commit text leaves its topology and file diff usable", async ({
  page,
  racco,
}) => {
  const cwd = racco.projects[0].path;
  const parent = (await runGit(["rev-parse", "HEAD"], { cwd })).trim();
  await writeFile(join(cwd, "encoding.txt"), "historical content\n");
  await runGit(["add", "--", "encoding.txt"], { cwd });
  const tree = (await runGit(["write-tree"], { cwd })).trim();
  const timestamp = Math.floor(Date.now() / 1000);
  const raw = Buffer.concat([
    Buffer.from(
      `tree ${tree}\nparent ${parent}\nauthor Fixture <fixture@example.com> ${timestamp} +0000\ncommitter Fixture <fixture@example.com> ${timestamp} +0000\nencoding ISO-8859-1\n\n`,
    ),
    Buffer.from([0x43, 0x61, 0x66, 0xe9, 0x0a]),
  ]);
  const oid = execFileSync(
    "git",
    ["hash-object", "-w", "-t", "commit", "--stdin"],
    { cwd, input: raw, encoding: "utf8" },
  ).trim();
  await runGit(["update-ref", "HEAD", oid], { cwd });
  await page.goto("/");
  await page.getByRole("button", { name: "展开 Git 修改侧栏" }).click();
  const history = await openHistory(page);
  expect(history.commits).toHaveLength(2);
  expect(history.commits[0].textUnavailableReason).not.toBeNull();
  await page.locator(`[data-commit-oid="${oid}"]`).click();
  await expect(page.locator(".git-commit-detail")).toContainText(
    history.commits[0].textUnavailableReason!,
  );
  await page
    .getByRole("button", { name: "提交文件 A encoding.txt", exact: true })
    .click();
  await expect(page.locator(".git-commit-diff .file-diff")).toContainText(
    "+historical content",
  );
});
