import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  ProjectEntry,
  SessionSummary,
  WorktreeEntry,
} from "../../shared/protocol.js";
import { SessionList } from "./SessionList.js";

const projects: ProjectEntry[] = [
  {
    projectId: "project-alpha",
    name: "alpha",
    path: "/work/alpha",
    available: true,
    createdAt: "2026-09-03T00:00:00.000Z",
  },
  {
    projectId: "project-empty",
    name: "empty",
    path: "/work/empty",
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
    sessionCount: 1,
  },
  {
    projectId: "project-alpha",
    path: "/worktrees/alpha-feature",
    kind: "linked",
    name: "alpha-feature",
    branch: "feature",
    head: "2222222",
    available: true,
    locked: false,
    prunable: true,
    removable: true,
    dirty: true,
    sessionCount: 0,
  },
  {
    projectId: "project-empty",
    path: "/work/empty",
    kind: "primary",
    name: "empty",
    branch: null,
    head: "3333333",
    available: true,
    locked: false,
    prunable: false,
    removable: false,
    dirty: false,
    sessionCount: 0,
  },
];

const sessions: SessionSummary[] = [
  {
    sessionId: "session-one",
    provider: "codex",
    projectId: "project-alpha",
    title: "First task",
    cwd: "/work/alpha",
    updatedAt: "2026-09-03T00:01:00.000Z",
    state: "running",
    lifecycle: "active",
    selectedModelSettings: null,
    contextUsage: null,
    compacting: false,
  },
];

function render(props: Partial<Parameters<typeof SessionList>[0]> = {}) {
  return renderToStaticMarkup(
    <SessionList
      worktrees={worktrees}
      selectedWorktreePath="/work/alpha"
      onSelectWorktree={() => undefined}
      onDeleteWorktree={() => undefined}
      onRefreshWorktrees={() => undefined}
      activeRef={{ sessionId: "session-one" }}
      loading={false}
      onNew={() => undefined}
      onOpen={() => undefined}
      projects={projects}
      sessions={sessions}
      {...props}
    />,
  );
}

test("renders the fixed project → worktree → session tree", () => {
  const html = render();

  assert.match(html, /alt="Racco"/);
  // Three levels, always: the middle layer is present even for a project whose
  // only worktree is its own directory.
  assert.match(
    html,
    /aria-label="项目 alpha"[\s\S]*aria-label="alpha 的 Worktree"[\s\S]*aria-label="alpha 的对话"[\s\S]*First task[\s\S]*Codex · 运行中/,
  );
  assert.match(
    html,
    /aria-label="项目 empty"[\s\S]*aria-label="empty 的 Worktree"[\s\S]*aria-label="empty 的对话"[\s\S]*暂无对话/,
  );
  assert.match(html, /aria-current="page"/);
});

test("marks the primary worktree and offers delete only on linked ones", () => {
  const html = render();
  const primaryRow = html.slice(
    html.indexOf('aria-label="alpha 的 Worktree"'),
    html.indexOf("alpha-feature"),
  );
  assert.match(primaryRow, /主工作区/);
  assert.doesNotMatch(primaryRow, /删除 Worktree/);
  assert.match(html, /aria-label="删除 Worktree alpha-feature"/);
  assert.match(html, /aria-label="刷新 alpha 的 Worktree 列表"/);
});

test("groups sessions whose cwd matches no worktree", () => {
  const html = render({
    sessions: [
      ...sessions,
      {
        ...sessions[0]!,
        sessionId: "session-orphan",
        title: "Orphan task",
        cwd: "/worktrees/removed",
      },
    ],
  });
  assert.match(html, /已失效的 Worktree/);
  assert.match(html, /Orphan task/);
});

test("keeps the project row when the worktree list is unavailable", () => {
  const html = render({ worktrees: [] });
  assert.match(html, /aria-label="项目 alpha"/);
  assert.match(html, /暂无 Worktree/);
});
