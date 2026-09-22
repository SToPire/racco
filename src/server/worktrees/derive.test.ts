import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deriveWorktrees } from "./derive.js";
import { runGit } from "./git.js";
import { parseWorktreeList } from "./porcelain.js";

async function initRepository(root: string): Promise<void> {
  await runGit(["init", "-q", root]);
  await runGit(["config", "user.email", "fixture@example.com"], { cwd: root });
  await runGit(["config", "user.name", "Fixture"], { cwd: root });
  await writeFile(join(root, "tracked.txt"), "fixture\n");
  await runGit(["add", "-A"], { cwd: root });
  await runGit(["commit", "-qm", "init"], { cwd: root });
}

test("derives the primary worktree for a plain directory without failing", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "racco-derive-plain-"));
  t.after(() => rm(fixture, { force: true, recursive: true }));
  const project = join(fixture, "plain");
  await mkdir(project);

  const catalog = await deriveWorktrees({ projectPath: project });
  assert.equal(catalog.degradedReason, null);
  assert.equal(catalog.worktrees.length, 1);
  assert.equal(catalog.worktrees[0].kind, "primary");
  assert.equal(catalog.worktrees[0].path, project);
  assert.equal(catalog.worktrees[0].available, true);
  assert.equal(catalog.worktrees[0].removable, false);
});

test("lists linked worktrees including detached ones and never as primary", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "racco-derive-linked-"));
  t.after(() => rm(fixture, { force: true, recursive: true }));
  const project = join(fixture, "repo");
  await initRepository(project);
  const linked = join(fixture, "feature");
  await runGit(["worktree", "add", "-q", "-b", "feat/x", linked], {
    cwd: project,
  });

  const catalog = await deriveWorktrees({ projectPath: project });
  assert.equal(catalog.degradedReason, null);
  assert.equal(catalog.worktrees.length, 2);
  const [primary, entry] = catalog.worktrees;
  assert.equal(primary.kind, "primary");
  assert.equal(entry.kind, "linked");
  assert.equal(entry.path, linked);
  assert.equal(entry.branch, "feat/x");
  assert.equal(entry.name, "feature");
  assert.equal(entry.removable, true);
});

test("marks a worktree whose directory was removed as prunable, without pruning it", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "racco-derive-prunable-"));
  t.after(() => rm(fixture, { force: true, recursive: true }));
  const project = join(fixture, "repo");
  await initRepository(project);
  const linked = join(fixture, "gone");
  await runGit(["worktree", "add", "-q", "-b", "feat/gone", linked], {
    cwd: project,
  });
  await rm(linked, { force: true, recursive: true });

  const catalog = await deriveWorktrees({ projectPath: project });
  assert.equal(catalog.worktrees.length, 2);
  assert.equal(catalog.worktrees[1].prunable, true);
  assert.equal(catalog.worktrees[1].available, false);

  // Racco must not prune: the entry is still there on the next read.
  const again = await deriveWorktrees({ projectPath: project });
  assert.equal(again.worktrees.length, 2);
});

test("reports a locked worktree", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "racco-derive-locked-"));
  t.after(() => rm(fixture, { force: true, recursive: true }));
  const project = join(fixture, "repo");
  await initRepository(project);
  const linked = join(fixture, "held");
  await runGit(["worktree", "add", "-q", "-b", "feat/held", linked], {
    cwd: project,
  });
  await runGit(["worktree", "lock", linked], { cwd: project });

  const catalog = await deriveWorktrees({ projectPath: project });
  assert.equal(catalog.worktrees[1].locked, true);
});

test("degrades to the primary entry when the project directory is missing", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "racco-derive-missing-"));
  t.after(() => rm(fixture, { force: true, recursive: true }));
  const project = join(fixture, "absent");

  const catalog = await deriveWorktrees({ projectPath: project });
  assert.equal(catalog.worktrees.length, 1);
  assert.equal(catalog.worktrees[0].available, false);
  assert.notEqual(catalog.degradedReason, null);
});

test("regression: a real listing is never empty for a repository", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "racco-derive-empty-"));
  t.after(() => rm(fixture, { force: true, recursive: true }));
  const project = join(fixture, "repo");
  await initRepository(project);

  // Git always lists at least the repository's own checkout, which is why an
  // empty listing can only mean the read failed. deriveWorktrees relies on it.
  const stdout = await runGit(["worktree", "list", "--porcelain"], {
    cwd: project,
  });
  assert.notEqual(stdout.trim(), "");
  const parsed = parseWorktreeList(stdout);
  assert.equal(parsed.kind, "ok");

  const catalog = await deriveWorktrees({ projectPath: project });
  assert.equal(catalog.worktrees.length, 1);
  assert.equal(catalog.degradedReason, null);
});
