import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  ProjectEntry,
  SessionSummary,
  WorktreeEntry,
} from "../../shared/protocol.js";
import { ConfirmDeleteProjectDialog } from "./SessionList.js";

const project: ProjectEntry = {
  projectId: "project-alpha",
  name: "alpha",
  path: "/work/alpha",
  available: true,
  createdAt: "2026-09-03T00:00:00.000Z",
};

const cleanLinked: WorktreeEntry = {
  projectId: "project-alpha",
  path: "/worktrees/alpha-clean",
  kind: "linked",
  name: "alpha-clean",
  branch: "clean",
  head: "2222222",
  available: true,
  locked: false,
  prunable: true,
  removable: true,
  dirty: false,
  sessionCount: 0,
};

const dirtyLinked: WorktreeEntry = {
  ...cleanLinked,
  path: "/worktrees/alpha-dirty",
  name: "alpha-dirty",
  branch: "dirty",
  dirty: true,
};

function session(
  sessionId: string,
  cwd: string,
  title: string,
): SessionSummary {
  return {
    sessionId,
    provider: "codex",
    projectId: "project-alpha",
    title,
    cwd,
    updatedAt: "2026-09-03T00:01:00.000Z",
    state: "running",
    lifecycle: "active",
    selectedModelSettings: null,
    contextUsage: null,
    compacting: false,
  };
}

function render(
  props: {
    worktrees?: WorktreeEntry[];
    sessionsByPath?: Map<string, SessionSummary[]>;
    removeWorktrees?: boolean;
  } = {},
) {
  return renderToStaticMarkup(
    <ConfirmDeleteProjectDialog
      project={project}
      worktrees={props.worktrees ?? []}
      sessionsByPath={props.sessionsByPath ?? new Map()}
      removeWorktrees={props.removeWorktrees ?? false}
      onChangeRemoveWorktrees={() => undefined}
      onCancel={() => undefined}
      onConfirm={() => undefined}
    />,
  );
}

test("lists linked worktrees with a dirty badge only on the dirty ones", () => {
  const html = render({ worktrees: [cleanLinked, dirtyLinked] });
  assert.match(html, /该项目下有 2 个链接的 Worktree（目录与分支）：/);
  // The badge belongs to the dirty entry, and the clean entry has none: exactly
  // one occurrence, preceded by the dirty path.
  assert.match(html, /\/worktrees\/alpha-dirty[\s\S]*有未提交的修改/);
  assert.equal(html.match(/有未提交的修改/g)?.length, 1);
});

test("defaults to keeping worktree directories on disk and flags dirty ones in the checkbox", () => {
  const html = render({ worktrees: [dirtyLinked] });
  assert.doesNotMatch(html, /checked=""/);
  assert.match(html, /同时删除磁盘上的 Worktree 目录/);
  assert.match(html, /含 1 个未提交目录，删除后将无法恢复/);
});

test("checks the disk-cleanup box when the caller asks for removal", () => {
  const html = render({ worktrees: [dirtyLinked], removeWorktrees: true });
  assert.match(html, /checked=""/);
});

test("counts every conversation of the project, in any worktree or orphaned", () => {
  const sessionsByPath = new Map<string, SessionSummary[]>([
    ["/work/alpha", [session("session-primary", "/work/alpha", "Primary")]],
    [
      "/worktrees/alpha-dirty",
      [session("session-linked", "/worktrees/alpha-dirty", "Linked")],
    ],
    [
      "/worktrees/removed",
      [session("session-orphan", "/worktrees/removed", "Orphan")],
    ],
    // A different project's conversation must not be attributed to this one.
    [
      "/work/other",
      [
        {
          ...session("session-other", "/work/other", "Other"),
          projectId: "project-other",
        },
      ],
    ],
  ]);
  const html = render({ worktrees: [dirtyLinked], sessionsByPath });
  assert.match(html, /同时删除 3 个对话。/);
});

test("no linked worktrees: states it, offers no disk-cleanup checkbox, and still warns the project directory is kept", () => {
  const html = render();
  assert.match(html, /该项目下没有链接的 Worktree。/);
  assert.doesNotMatch(html, /同时删除磁盘上的 Worktree 目录/);
  assert.doesNotMatch(html, /同时删除 \d+ 个对话。/);
  assert.match(html, /项目目录本身不会被删除。/);
});

test("renders confirm and cancel actions", () => {
  const html = render({ worktrees: [dirtyLinked] });
  assert.match(html, />取消</);
  assert.match(html, />删除项目</);
});
