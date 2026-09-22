import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProjectEntry, WorktreeEntry } from "../../shared/protocol.js";
import { NewSessionView } from "./NewSessionView.js";

const projects: ProjectEntry[] = [
  {
    projectId: "project-alpha",
    name: "alpha",
    path: "/work/alpha",
    available: true,
    createdAt: "2026-09-03T00:00:00.000Z",
  },
];

const worktrees: WorktreeEntry[] = [
  {
    projectId: "project-alpha",
    path: "/work/alpha",
    kind: "primary",
    name: "alpha",
    branch: "main",
    head: "1111111",
    available: true,
    locked: false,
    prunable: false,
    removable: false,
    dirty: false,
    sessionCount: 0,
  },
  {
    projectId: "project-alpha",
    path: "/worktrees/alpha-detached",
    kind: "linked",
    name: "alpha-detached",
    branch: null,
    head: "2222222",
    available: true,
    locked: false,
    prunable: false,
    removable: true,
    dirty: false,
    sessionCount: 0,
  },
];

function render(props: Partial<Parameters<typeof NewSessionView>[0]> = {}) {
  return renderToStaticMarkup(
    <NewSessionView
      active={true}
      busyWorktree={false}
      connected={true}
      creating={false}
      health={{ ok: true, providers: { codex: "ready", claude: "ready" } }}
      onBack={() => undefined}
      onCreate={async () => true}
      onCreateWorktree={async () => undefined}
      onImportProject={() => undefined}
      onProjectChange={() => undefined}
      onWorktreeChange={() => undefined}
      projectId=""
      projects={[]}
      worktreePath=""
      worktrees={[]}
      {...props}
    />,
  );
}

test("requires a project and exposes the project picker", () => {
  const html = render();
  assert.match(html, /aria-label="项目"/);
  assert.match(html, /请先导入项目/);
  assert.match(html, /aria-label="新建并发送"[^>]*disabled=""/);
});

test("requires a worktree before sending and names the target", () => {
  const html = render({
    projects,
    worktrees,
    projectId: "project-alpha",
  });
  assert.match(html, /aria-label="Worktree"/);
  assert.match(html, /将在 alpha 中创建/);
  assert.match(html, /新建 Worktree…/);
  assert.match(html, /aria-label="新建并发送"[^>]*disabled=""/);
});

test("an unavailable worktree blocks sending", () => {
  const html = render({
    projects,
    worktrees: [{ ...worktrees[0]!, available: false }],
    projectId: "project-alpha",
  });
  assert.match(html, /所选 Worktree 目录不可用/);
  assert.match(html, /aria-label="新建并发送"[^>]*disabled=""/);
});

test("surfaces a worktree failure next to the picker", () => {
  const html = render({
    projects,
    worktrees,
    projectId: "project-alpha",
    worktreeError: "项目目录不是 Git 主工作区",
  });
  assert.match(html, /项目目录不是 Git 主工作区/);
});
