import { test, expect } from "./fixtures";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

test("older sessions can be paged in, filtered and imported", async ({
  page,
  racco,
}) => {
  await Promise.all(
    Array.from({ length: 51 }, (_, index) =>
      writeFile(
        join(racco.directory, "providers", "codex", `paged-${index}.json`),
        JSON.stringify({
          cwd: racco.projects[0]!.path,
          metadata: {
            title: `Paged session ${String(index).padStart(3, "0")}`,
            updatedAt: new Date(1700000000000 + index * 1000).toISOString(),
          },
          events: [],
        }),
      ),
    ),
  );
  await page.goto(`/session/${racco.sessions[0]!.sessionId}`);
  await page.getByRole("button", { name: "展开会话侧栏" }).click();
  const dock = page.getByRole("complementary", { name: "会话侧栏" });
  await expect(dock.getByRole("listitem")).toHaveCount(50);
  await dock
    .getByRole("searchbox", { name: "筛选已加载会话" })
    .fill("Paged session 000");
  await expect(dock).toContainText("已加载会话中没有匹配项");
  await dock.getByRole("button", { name: "加载更多会话" }).click();
  await dock
    .getByRole("button", { name: "导入并打开 Paged session 000", exact: true })
    .click();
  await expect(page.locator(".session-title-line h1")).toHaveText(
    "Paged session 000",
  );
  await expect(dock.getByRole("button", { name: "加载更多会话" })).toHaveCount(
    0,
  );
});

test("project sessions are discovered on demand, imported once and synchronized; Files state survives switching", async ({
  page,
  context,
  racco,
}) => {
  const other = await context.newPage();
  await other.goto("/");
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/native-sessions"))
      requests.push(request.url());
  });
  await page.goto(`/session/${racco.sessions[0]!.sessionId}`);
  await expect(page.locator(".session-title-line h1")).toContainText(
    "[Fixture]",
  );
  expect(requests).toHaveLength(0);
  await page.getByRole("button", { name: "展开文件侧栏" }).click();
  await page.getByRole("button", { name: "目录 src", exact: true }).click();
  await page
    .getByRole("button", { name: "文件 src/index.ts", exact: true })
    .click();
  await expect(page.locator(".file-code-grid")).toContainText("answer = 42");
  expect(requests).toHaveLength(0);
  await page.getByRole("button", { name: "展开会话侧栏" }).click();
  const dock = page.getByRole("complementary", { name: "会话侧栏" });
  await expect(
    dock.getByRole("button", {
      name: "导入并打开 codex Alpha history",
      exact: true,
    }),
  ).toBeVisible();
  await expect(dock).not.toContainText("Beta history");
  await expect(
    dock.getByRole("button", { name: "打开 [Fixture] codex", exact: true }),
  ).toBeVisible();
  expect((await (await page.request.get("/api/sessions")).json()).length).toBe(
    2,
  );
  await dock
    .getByRole("button", {
      name: "导入并打开 codex Alpha history",
      exact: true,
    })
    .click();
  await expect(page.locator(".session-title-line h1")).toHaveText(
    "codex Alpha history",
  );
  await expect(
    other.locator(".history-row").filter({ hasText: "codex Alpha history" }),
  ).toBeVisible();
  await expect(
    dock.getByRole("button", { name: "打开 codex Alpha history", exact: true }),
  ).toBeVisible();
  const url = page.url();
  await dock
    .getByRole("button", { name: "打开 codex Alpha history", exact: true })
    .click();
  await expect(page).toHaveURL(url);
  expect((await (await page.request.get("/api/sessions")).json()).length).toBe(
    3,
  );
  await page.getByRole("button", { name: "展开文件侧栏" }).click();
  await expect(page.getByRole("tab", { name: "index.ts" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator(".file-code-grid")).toContainText("answer = 42");
});

test("session dock follows the selected project and can import Claude on a narrow screen", async ({
  page,
  racco,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "项目", exact: true }).click();
  await page.getByRole("option", { name: "beta", exact: true }).click();
  await page.getByRole("button", { name: "展开会话侧栏" }).click();
  const dock = page.getByRole("complementary", { name: "会话侧栏" });
  await expect(
    dock.getByRole("combobox", { name: "会话侧栏项目" }),
  ).toHaveValue(racco.projects[1]!.projectId);
  await expect(dock).toContainText("codex Beta history");
  await dock.getByRole("button", { name: "Claude", exact: true }).click();
  await dock
    .getByRole("button", {
      name: "导入并打开 claude Beta history",
      exact: true,
    })
    .click();
  await expect(dock).not.toContainText("Alpha history");
  await dock.getByRole("button", { name: "折叠会话侧栏" }).click();
  await expect(
    page.getByRole("button", { name: "展开会话侧栏" }),
  ).toBeFocused();
  await expect(page.locator(".session-title-line h1")).toHaveText(
    "claude Beta history",
  );
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await page.getByRole("option", { name: /Fixture Primary/ }).click();
  await page
    .getByRole("textbox", { name: "发送给 Racco" })
    .fill("import-followup");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(
    page.getByText("Fixture: import-followup", { exact: true }),
  ).toBeVisible();
});

test("discovery errors can be retried and a late page cannot replace the chosen project", async ({
  page,
  racco,
}) => {
  await page.goto(`/session/${racco.sessions[0]!.sessionId}`);
  await page.route(
    "**/native-sessions?*",
    (route) =>
      route.fulfill({ status: 503, json: { message: "会话来源暂不可用" } }),
    { times: 1 },
  );
  await page.getByRole("button", { name: "展开会话侧栏" }).click();
  const dock = page.getByRole("complementary", { name: "会话侧栏" });
  await expect(dock.getByRole("alert")).toContainText("会话来源暂不可用");
  await dock.getByRole("button", { name: "重试", exact: true }).click();
  await expect(dock).toContainText("codex Alpha history");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route(
    `**/projects/${racco.projects[0]!.projectId}/native-sessions?*`,
    async (route) => {
      const response = await route.fetch();
      started();
      await gate;
      await route.fulfill({ response }).catch(() => {});
    },
  );
  try {
    await dock.getByRole("button", { name: "刷新会话列表" }).click();
    await waiting;
    await page
      .getByRole("region", { name: "项目 beta", exact: true })
      .locator(".project-tree-header")
      .click();
    await expect(dock).toContainText("codex Beta history");
    release();
    await expect(dock).not.toContainText("codex Alpha history");
  } finally {
    release();
  }
});

test("an import finishing after changing projects does not navigate away", async ({
  page,
  racco,
}) => {
  await page.goto(`/session/${racco.sessions[0]!.sessionId}`);
  await page.getByRole("button", { name: "展开会话侧栏" }).click();
  const dock = page.getByRole("complementary", { name: "会话侧栏" });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route("**/api/sessions/import", async (route) => {
    const response = await route.fetch();
    started();
    await gate;
    await route.fulfill({ response });
  });
  try {
    await dock
      .getByRole("button", {
        name: "导入并打开 codex Alpha history",
        exact: true,
      })
      .click();
    await waiting;
    await dock
      .getByRole("combobox", { name: "会话侧栏项目" })
      .selectOption(racco.projects[1]!.projectId);
    await expect(dock).toContainText("codex Beta history");
    const completed = page.waitForResponse("**/api/sessions/import");
    release();
    await completed;
    await expect(page).toHaveURL(`/session/${racco.sessions[0]!.sessionId}`);
    await expect(
      dock.getByRole("combobox", { name: "会话侧栏项目" }),
    ).toHaveValue(racco.projects[1]!.projectId);
  } finally {
    release();
  }
});

test("native sessions can be deleted for real, managed ones also leave Racco", async ({
  page,
  context,
  racco,
}) => {
  const other = await context.newPage();
  await other.goto("/");
  await page.goto(`/session/${racco.sessions[0]!.sessionId}`);
  await page.getByRole("button", { name: "展开会话侧栏" }).click();
  const dock = page.getByRole("complementary", { name: "会话侧栏" });
  page.on("dialog", (dialog) => dialog.accept());
  await dock
    .getByRole("button", { name: "彻底删除 codex Alpha history", exact: true })
    .click();
  await expect(dock).not.toContainText("codex Alpha history");
  const remaining = await (
    await page.request.get(
      `/api/projects/${racco.projects[0]!.projectId}/native-sessions?provider=codex`,
    )
  ).json();
  expect(
    remaining.sessions.some(
      (item: { providerSessionId: string }) =>
        item.providerSessionId === "native-codex-alpha",
    ),
  ).toBe(false);
  expect((await (await page.request.get("/api/sessions")).json()).length).toBe(
    2,
  );

  // A managed session disappears from both clients' sidebars when deleted.
  await dock
    .getByRole("button", { name: "彻底删除 [Fixture] codex", exact: true })
    .click();
  await expect(dock).not.toContainText("[Fixture] codex");
  await expect(page).toHaveURL("/");
  await expect(
    other.locator(".history-row").filter({ hasText: "[Fixture] codex" }),
  ).toHaveCount(0);
  expect((await (await page.request.get("/api/sessions")).json()).length).toBe(
    1,
  );

  // Cancelling the confirmation keeps the session on disk and in the list.
  const cancelPage = await context.newPage();
  await cancelPage.goto(`/session/${racco.sessions[1]!.sessionId}`);
  await cancelPage.getByRole("button", { name: "展开会话侧栏" }).click();
  const cancelDock = cancelPage.getByRole("complementary", {
    name: "会话侧栏",
  });
  await cancelDock
    .getByRole("combobox", { name: "会话侧栏项目" })
    .selectOption(racco.projects[1]!.projectId);
  await cancelDock.getByRole("button", { name: "Claude", exact: true }).click();
  const cancelledRow = cancelDock.getByRole("listitem").filter({
    hasText: "claude Beta history",
  });
  await cancelledRow.hover();
  cancelPage.once("dialog", (dialog) => dialog.dismiss());
  await cancelledRow
    .getByRole("button", { name: "彻底删除 claude Beta history", exact: true })
    .click();
  await expect(
    cancelDock.getByRole("button", {
      name: "导入并打开 claude Beta history",
      exact: true,
    }),
  ).toBeVisible();
});

test("deleting a loaded Claude session resets pagination without losing unseen rows or the filter", async ({
  page,
  racco,
}) => {
  await Promise.all(
    Array.from({ length: 50 }, (_, index) =>
      writeFile(
        join(racco.directory, "providers", "claude", `cursor-${index}.json`),
        JSON.stringify({
          cwd: racco.projects[1]!.path,
          metadata: {
            title: `Cursor session ${String(index).padStart(3, "0")}`,
            updatedAt: new Date(1700000000000 + index * 1000).toISOString(),
          },
          events: [],
        }),
      ),
    ),
  );
  await page.goto(`/session/${racco.sessions[1]!.sessionId}`);
  await page.getByRole("button", { name: "展开会话侧栏" }).click();
  const dock = page.getByRole("complementary", { name: "会话侧栏" });
  await dock.getByRole("button", { name: "Claude", exact: true }).click();
  await expect(dock.getByRole("listitem")).toHaveCount(50);
  const filter = dock.getByRole("searchbox", { name: "筛选已加载会话" });
  await filter.fill("Cursor session");
  await expect(dock.getByRole("listitem")).toHaveCount(48);
  page.once("dialog", (dialog) => dialog.accept());
  await dock
    .getByRole("button", { name: "彻底删除 Cursor session 049", exact: true })
    .click();
  await expect(
    dock.getByRole("button", {
      name: "彻底删除 Cursor session 049",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(filter).toHaveValue("Cursor session");
  // Refresh fills the vacated slot with a previously unseen row.
  await expect(dock.getByRole("listitem")).toHaveCount(48);
  await dock.getByRole("button", { name: "加载更多会话" }).click();
  await expect(dock.getByRole("listitem")).toHaveCount(49);
  await expect(dock.getByRole("button", { name: "加载更多会话" })).toHaveCount(
    0,
  );
  await expect(dock).toContainText("Cursor session 001");
  await expect(dock).toContainText("Cursor session 000");
  await filter.clear();
  await expect(dock.getByRole("listitem")).toHaveCount(51);
});
