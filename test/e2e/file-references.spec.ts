import type { Page, WebSocketRoute } from "@playwright/test";
import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ServerMessage, TimelineEvent } from "../../src/shared/protocol";
import { test, expect } from "./fixtures";

async function openSessionTimeline(page: Page, sessionId: string) {
  let socket: WebSocketRoute | undefined;
  await page.routeWebSocket("**/api/ws", (route) => {
    socket = route;
    route.connectToServer();
  });
  await page.goto(`/session/${sessionId}`);
  await expect(
    page
      .locator(".timeline")
      .getByText("这是固定的开发测试场景。", { exact: false }),
  ).toBeVisible();
  return (event: TimelineEvent) => {
    if (socket === undefined)
      throw new Error("The session socket is not connected");
    socket.send(
      JSON.stringify({
        type: "timeline.event",
        session: { sessionId },
        event,
      } satisfies ServerMessage),
    );
  };
}

test("markdown references select the session project, reuse tabs and locate lines without escaping the project", async ({
  page,
  racco,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const project = racco.projects[0]!;
  const other = racco.projects[1]!;
  await Promise.all([
    writeFile(
      join(project.path, "src", "long.ts"),
      Array.from(
        { length: 140 },
        (_, index) => `export const line${index + 1} = ${index + 1};`,
      ).join("\n"),
    ),
    symlink(
      join(other.path, "other.txt"),
      join(project.path, "outside-link.ts"),
    ),
  ]);
  const emit = await openSessionTimeline(page, racco.sessions[0]!.sessionId);
  emit({
    type: "assistant.message",
    id: "file-references",
    text: [
      "[查看第90行](src/long.ts#L90)",
      `[同文件第10行](${project.path}/src/long.ts:10)`,
      "[不存在的行](src/long.ts#L999)",
      `[项目外文件](${other.path}/other.txt)`,
      "[编码越界](%2e%2e/beta/other.txt)",
      "[外部文档](https://example.com/reference)",
      "[越界符号链接](outside-link.ts)",
    ].join("\n\n"),
  });
  await page.getByRole("button", { name: "展开文件侧栏" }).click();
  const projectSelector = page.getByRole("combobox", { name: "文件侧栏项目" });
  await projectSelector.selectOption(other.projectId);
  await page.getByRole("button", { name: "查看第90行", exact: true }).click();
  await expect(projectSelector).toHaveValue(project.projectId);
  const preview = page.getByLabel("文件内容 src/long.ts", { exact: true });
  await expect(preview).toContainText("export const line90 = 90;");
  const selectedLine = page.locator(".file-line-number-selected");
  await expect(selectedLine).toHaveText("90");
  await expect(selectedLine).toBeInViewport();
  await preview.evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.getByRole("button", { name: "查看第90行", exact: true }).click();
  await expect(selectedLine).toBeInViewport();
  await page.getByRole("button", { name: "同文件第10行", exact: true }).click();
  await expect(selectedLine).toHaveText("10");
  await expect(
    page.getByRole("tab", { name: "long.ts", exact: true }),
  ).toHaveCount(1);
  await page.getByRole("button", { name: "不存在的行", exact: true }).click();
  await expect(page.locator(".file-preview-status")).toContainText(
    "第 999 行不存在",
  );
  await expect(selectedLine).toHaveCount(0);

  await expect(page.getByText("项目外文件", { exact: true })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await expect(page.getByText("编码越界", { exact: true })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await expect(page.getByRole("link", { name: "外部文档" })).toHaveAttribute(
    "href",
    "https://example.com/reference",
  );
  await page.getByRole("button", { name: "越界符号链接", exact: true }).click();
  await expect(page.locator(".file-error")).toContainText(
    "这个链接指向项目目录之外",
  );
  await expect(page.locator(".file-code-grid")).toHaveCount(0);
});

test("file change paths open the existing read-only preview using literal filenames", async ({
  page,
  racco,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const path = "src/a%20b#L2:5.ts";
  const absolutePath = join(racco.projects[0]!.path, path);
  await writeFile(absolutePath, "export const literalFilename = true;\n");
  const emit = await openSessionTimeline(page, racco.sessions[0]!.sessionId);
  emit({
    type: "tool.started",
    id: "literal-file-change",
    tool: "fileChange",
    input: [
      {
        path: absolutePath,
        kind: { type: "add" },
        diff: "+export const literalFilename = true;",
      },
    ],
  });
  emit({
    type: "tool.completed",
    id: "literal-file-change",
    status: "completed",
  });
  await page.locator(".tool-card").filter({ hasText: "a%20b#L2:5.ts" }).click();
  const inspector = page.getByRole("complementary", { name: "工具详情" });
  await inspector
    .getByRole("button", { name: absolutePath, exact: true })
    .click();
  await expect(inspector).toHaveCount(0);
  await expect(
    page.getByLabel(`文件内容 ${path}`, { exact: true }),
  ).toContainText("literalFilename = true");
  await expect(page.locator(".file-preview-toolbar")).toContainText("只读");
  await expect(
    page.getByRole("tab", { name: "a%20b#L2:5.ts", exact: true }),
  ).toHaveCount(1);
});

test("child Markdown, trajectory results and tool changes resolve against the actor directory", async ({
  page,
  racco,
}) => {
  await page.setViewportSize({ width: 1800, height: 1000 });
  const project = racco.projects[0]!;
  await writeFile(
    join(project.path, "src", "README.md"),
    "Child directory content\n",
  );
  const emit = await openSessionTimeline(page, racco.sessions[0]!.sessionId);
  emit({
    type: "subagent.started",
    id: "child-start",
    agentId: "child",
    name: "Child",
    cwd: join(project.path, "src"),
    prompt: "Inspect child files",
  });
  emit({
    type: "subagent.event",
    id: "child-link-event",
    agentId: "child",
    event: {
      type: "assistant.message",
      id: "child-link",
      text: "[Child readme](README.md#L1)",
    },
  });
  emit({
    type: "subagent.event",
    id: "child-change-start",
    agentId: "child",
    event: {
      type: "tool.started",
      id: "child-change",
      tool: "fileChange",
      input: [
        {
          path: "README.md",
          kind: { type: "update", move_path: null },
          diff: "+Child directory content",
        },
      ],
    },
  });
  emit({
    type: "subagent.event",
    id: "child-change-end",
    agentId: "child",
    event: { type: "tool.completed", id: "child-change", status: "completed" },
  });
  emit({
    type: "subagent.started",
    id: "outside-start",
    agentId: "outside",
    name: "Outside",
    cwd: racco.projects[1]!.path,
    prompt: "External work directory",
  });
  emit({
    type: "subagent.event",
    id: "outside-link-event",
    agentId: "outside",
    event: {
      type: "assistant.message",
      id: "outside-link",
      text: "[Outside relative](README.md)",
    },
  });
  await page
    .getByRole("button", { name: "查看 Child 的对话", exact: true })
    .click();
  await page.getByRole("button", { name: "Child readme", exact: true }).click();
  await expect(
    page.getByLabel("文件内容 src/README.md", { exact: true }),
  ).toContainText("Child directory content");
  await page
    .locator(".trajectory-tool-row")
    .filter({ hasText: "README.md" })
    .click();
  const inspector = page.getByRole("complementary", { name: "工具详情" });
  await inspector
    .getByRole("button", { name: "README.md", exact: true })
    .click();
  await expect(
    page.getByLabel("文件内容 src/README.md", { exact: true }),
  ).toContainText("Child directory content");
  await expect(
    page.getByRole("tab", { name: "README.md", exact: true }),
  ).toHaveCount(1);
  await page.getByRole("button", { name: "Trajectory", exact: true }).click();
  await page
    .locator(".trajectory-entry")
    .filter({ hasText: "Child readme" })
    .click();
  const trajectory = page.getByRole("complementary", { name: "交互详情" });
  await trajectory.getByRole("button", { name: "Result", exact: true }).click();
  await trajectory
    .getByRole("button", { name: "Child readme", exact: true })
    .click();
  await expect(
    page.getByLabel("文件内容 src/README.md", { exact: true }),
  ).toContainText("Child directory content");
  await page.locator(".agent-switcher-trigger").click();
  await page.getByRole("option").filter({ hasText: "Outside" }).click();
  await expect(
    page.getByText("Outside relative", { exact: true }),
  ).toHaveAttribute("aria-disabled", "true");
});
