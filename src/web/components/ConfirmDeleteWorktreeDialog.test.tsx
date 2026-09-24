import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorktreeEntry } from "../../shared/protocol.js";
import { ConfirmDeleteWorktreeDialog } from "./SessionList.js";

const worktree: WorktreeEntry = {
  projectId: "project-alpha",
  path: "/worktrees/alpha-feature",
  kind: "linked",
  name: "alpha-feature",
  branch: "feature/alpha",
  head: "2222222",
  available: true,
  locked: false,
  prunable: false,
  removable: true,
  dirty: true,
  sessionCount: 2,
};

function render(entry: WorktreeEntry = worktree, deleteBranch = false): string {
  return renderToStaticMarkup(
    <ConfirmDeleteWorktreeDialog
      worktree={entry}
      deleteBranch={deleteBranch}
      onChangeDeleteBranch={() => undefined}
      onCancel={() => undefined}
      onConfirm={() => undefined}
    />,
  );
}

test("defaults to retaining the local branch and names every destructive effect", () => {
  const html = render();
  assert.match(html, /删除 Worktree alpha-feature/);
  assert.match(html, /\/worktrees\/alpha-feature/);
  assert.match(html, /同时删除本地分支 feature\/alpha/);
  assert.doesNotMatch(html, /checked=""/);
  assert.doesNotMatch(html, /已提交历史会保留/);
  assert.match(
    html,
    /confirm-delete-dialog-danger[^>]*>存在未提交或未跟踪的内容，删除后无法恢复。/,
  );
  assert.match(html, /confirm-delete-dialog-path-block/);
  assert.match(html, /同时删除 2 个对话/);
});

test("a checked branch option warns that only the local branch is deleted", () => {
  const html = render(worktree, true);
  assert.match(html, /checked=""/);
  assert.match(html, /远程分支不受影响/);
  assert.match(html, /Git reflog/);
});

test("a detached worktree does not offer branch deletion", () => {
  const html = render({ ...worktree, branch: null, dirty: false });
  assert.doesNotMatch(html, /同时删除本地分支/);
  assert.match(html, /detached Worktree/);
});
