import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deriveWorktrees } from "./derive.js";
import { GitUnavailableError } from "./git.js";
import { runGit } from "./git.js";
import {
  createWorktree,
  projectSlug,
  removeAllLinkedWorktrees,
  removeWorktree,
  validateWorktreeName,
  WorktreeNameError,
  WorktreeNotLinkedError,
  WorktreeTargetExistsError,
  worktreeDirectoryName,
  worktreeIsDirty,
} from "./manager.js";

async function initRepository(root: string): Promise<void> {
  await runGit(["init", "-q", root]);
  await runGit(["config", "user.email", "fixture@example.com"], { cwd: root });
  await runGit(["config", "user.name", "Fixture"], { cwd: root });
  await writeFile(join(root, "tracked.txt"), "fixture\n");
  await runGit(["add", "-A"], { cwd: root });
  await runGit(["commit", "-qm", "init"], { cwd: root });
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

type Fixture = {
  fixture: string;
  project: string;
  worktreeRoot: string;
};

async function setUp(t: test.TestContext, name: string): Promise<Fixture> {
  const fixture = await mkdtemp(join(tmpdir(), `racco-manager-${name}-`));
  t.after(() => rm(fixture, { force: true, recursive: true }));
  const project = join(fixture, "repo");
  await mkdir(project);
  await initRepository(project);
  return { fixture, project, worktreeRoot: join(fixture, "worktrees") };
}

test("creates a linked worktree with its own branch and returns the new catalog", async (t) => {
  const { project, worktreeRoot } = await setUp(t, "create");

  const catalog = await createWorktree({
    projectPath: project,
    worktreeRoot,
    name: "feat/one",
  });

  assert.equal(catalog.degradedReason, null);
  assert.equal(catalog.worktrees.length, 2);
  const entry = catalog.worktrees[1];
  assert.equal(entry.kind, "linked");
  assert.equal(entry.branch, "feat/one");
  assert.equal(entry.name, "feat-one");
  assert.equal(entry.available, true);
  assert.equal(
    entry.path,
    join(worktreeRoot, projectSlug(project), "feat-one"),
  );
  assert.equal(await exists(entry.path), true);
});

test("creates a worktree from an explicit base ref", async (t) => {
  const { project, worktreeRoot } = await setUp(t, "base");
  await runGit(["branch", "release"], { cwd: project });

  const catalog = await createWorktree({
    projectPath: project,
    worktreeRoot,
    name: "from-release",
    baseRef: "release",
  });

  assert.equal(catalog.worktrees[1].branch, "from-release");
  const head = await runGit(["rev-parse", "release"], { cwd: project });
  assert.equal(catalog.worktrees[1].head, head.trim());
});

test("refuses a name Git rejects, with Git's own reason", async (t) => {
  const { project, worktreeRoot } = await setUp(t, "badname");

  for (const name of ["bad name", "a..b", "-lead", "trail.", "x.lock"]) {
    await assert.rejects(
      createWorktree({ projectPath: project, worktreeRoot, name }),
      WorktreeNameError,
      `expected ${name} to be rejected`,
    );
  }
  // Nothing was created for a rejected name.
  assert.equal(
    (await deriveWorktrees({ projectPath: project })).worktrees.length,
    1,
  );
});

test("accepts a UTF-8 branch name and flattens its directory", async (t) => {
  const { project, worktreeRoot } = await setUp(t, "unicode");

  await validateWorktreeName("特性/分支", project);
  assert.equal(worktreeDirectoryName("特性/分支"), "特性-分支");

  const catalog = await createWorktree({
    projectPath: project,
    worktreeRoot,
    name: "特性/分支",
  });
  assert.equal(catalog.worktrees[1].branch, "特性/分支");
});

test("refuses to create when the branch already exists", async (t) => {
  const { project, worktreeRoot } = await setUp(t, "duplicate");
  await runGit(["branch", "taken"], { cwd: project });

  await assert.rejects(
    createWorktree({ projectPath: project, worktreeRoot, name: "taken" }),
    /already exists/,
  );
});

test("refuses to create when the target directory already exists", async (t) => {
  const { project, worktreeRoot } = await setUp(t, "target");
  const target = join(worktreeRoot, projectSlug(project), "occupied");
  await mkdir(target, { recursive: true });

  await assert.rejects(
    createWorktree({ projectPath: project, worktreeRoot, name: "occupied" }),
    WorktreeTargetExistsError,
  );
});

test("refuses to create inside a project that is itself a linked worktree", async (t) => {
  const { project, worktreeRoot } = await setUp(t, "linked-project");
  const nested = join(worktreeRoot, "nested");
  await runGit(["worktree", "add", "-q", "-b", "nested", nested], {
    cwd: project,
  });

  // Running `worktree add` from inside a linked worktree succeeds in Git, so the
  // guard must come from `--git-dir`, not from "is a repository".
  await assert.rejects(
    createWorktree({
      projectPath: nested,
      worktreeRoot: join(worktreeRoot, "other"),
      name: "child",
    }),
    /不是 Git 主工作区/,
  );
});

test("refuses to create inside a directory that is not a repository", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "racco-manager-plain-"));
  t.after(() => rm(fixture, { force: true, recursive: true }));
  const plain = join(fixture, "plain");
  await mkdir(plain);

  await assert.rejects(
    createWorktree({
      projectPath: plain,
      worktreeRoot: join(fixture, "worktrees"),
      name: "nope",
    }),
    /不是 Git 主工作区/,
  );
});

test("reports dirtiness from inside the worktree, including untracked files", async (t) => {
  const { project, worktreeRoot } = await setUp(t, "dirty");
  const catalog = await createWorktree({
    projectPath: project,
    worktreeRoot,
    name: "clean-tree",
  });
  const target = catalog.worktrees[1].path;
  assert.equal(await worktreeIsDirty(target), false);

  await writeFile(join(target, "untracked.txt"), "new\n");
  assert.equal(await worktreeIsDirty(target), true);

  await rm(join(target, "untracked.txt"));
  await writeFile(join(target, "tracked.txt"), "modified\n");
  assert.equal(await worktreeIsDirty(target), true);
});

test("removes a dirty worktree with --force and keeps its branch", async (t) => {
  const { project, worktreeRoot } = await setUp(t, "force");
  const catalog = await createWorktree({
    projectPath: project,
    worktreeRoot,
    name: "feat/dirty",
  });
  const target = catalog.worktrees[1].path;
  await writeFile(join(target, "tracked.txt"), "uncommitted\n");

  const after = await removeWorktree({
    projectPath: project,
    path: target,
    force: true,
  });

  assert.equal(after.worktrees.length, 1);
  assert.equal(await exists(target), false);
  const branches = await runGit(["branch", "--list", "feat/dirty"], {
    cwd: project,
  });
  assert.notEqual(branches.trim(), "");
});

test("removes a worktree whose directory was already deleted", async (t) => {
  const { project, worktreeRoot } = await setUp(t, "prunable");
  const catalog = await createWorktree({
    projectPath: project,
    worktreeRoot,
    name: "already-gone",
  });
  const target = catalog.worktrees[1].path;
  await rm(target, { force: true, recursive: true });

  const after = await removeWorktree({ projectPath: project, path: target });

  assert.equal(after.worktrees.length, 1);
});

test("refuses to remove a locked worktree instead of overriding the lock", async (t) => {
  const { project, worktreeRoot } = await setUp(t, "locked");
  const catalog = await createWorktree({
    projectPath: project,
    worktreeRoot,
    name: "held",
  });
  const target = catalog.worktrees[1].path;
  await runGit(["worktree", "lock", target], { cwd: project });

  await assert.rejects(
    removeWorktree({ projectPath: project, path: target }),
    /locked working tree/,
  );
  assert.equal(await exists(target), true);
});

test("refuses to remove the project directory or an unrelated path", async (t) => {
  const { fixture, project, worktreeRoot } = await setUp(t, "guard");
  await createWorktree({
    projectPath: project,
    worktreeRoot,
    name: "real",
  });

  // The project directory is the primary worktree: it is not a linked entry, so
  // it is refused here before Git is ever asked.
  await assert.rejects(
    removeWorktree({ projectPath: project, path: project }),
    WorktreeNotLinkedError,
  );
  const outsider = join(fixture, "outsider");
  await mkdir(outsider);
  await assert.rejects(
    removeWorktree({ projectPath: project, path: outsider }),
    WorktreeNotLinkedError,
  );
  // Both refusals left the directory alone.
  assert.equal(await exists(project), true);
  assert.equal(await exists(outsider), true);
});

test("cascades over every linked worktree and leaves the project directory", async (t) => {
  const { project, worktreeRoot } = await setUp(t, "cascade");
  const first = await createWorktree({
    projectPath: project,
    worktreeRoot,
    name: "one",
  });
  const second = await createWorktree({
    projectPath: project,
    worktreeRoot,
    name: "two",
  });
  const firstPath = first.worktrees[1].path;
  const secondPath = second.worktrees
    .map((entry) => entry.path)
    .find((path) => path !== project && path !== firstPath);
  assert.notEqual(secondPath, undefined);
  // One of them holds uncommitted work, which the cascade discards.
  await writeFile(join(firstPath, "scratch.txt"), "uncommitted\n");

  const removals = await removeAllLinkedWorktrees(project);

  assert.deepEqual(
    removals.map((removal) => removal.path).sort(),
    [firstPath, secondPath].sort(),
  );
  assert.equal(
    removals.every((removal) => removal.removed),
    true,
    JSON.stringify(removals),
  );
  assert.equal(await exists(firstPath), false);
  assert.equal(await exists(secondPath as string), false);
  assert.equal(await exists(project), true);
  assert.equal(
    (await deriveWorktrees({ projectPath: project })).worktrees.length,
    1,
  );
});

test("reports a failed cascade removal without stopping the rest", async (t) => {
  const { project, worktreeRoot } = await setUp(t, "cascade-fail");
  const created = await createWorktree({
    projectPath: project,
    worktreeRoot,
    name: "locked",
  });
  await createWorktree({ projectPath: project, worktreeRoot, name: "free" });
  await runGit(["worktree", "lock", created.worktrees[1].path], {
    cwd: project,
  });

  const removals = await removeAllLinkedWorktrees(project);

  const failed = removals.filter((removal) => !removal.removed);
  assert.equal(failed.length, 1);
  assert.match(failed[0].reason ?? "", /locked working tree/);
  assert.equal(removals.filter((removal) => removal.removed).length, 1);
});

test("keeps two projects with the same directory name apart", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "racco-manager-collide-"));
  t.after(() => rm(fixture, { force: true, recursive: true }));
  const worktreeRoot = join(fixture, "worktrees");
  const first = join(fixture, "a", "repo");
  const second = join(fixture, "b", "repo");
  await mkdir(first, { recursive: true });
  await mkdir(second, { recursive: true });
  await initRepository(first);
  await initRepository(second);

  const one = await createWorktree({
    projectPath: first,
    worktreeRoot,
    name: "same",
  });
  const two = await createWorktree({
    projectPath: second,
    worktreeRoot,
    name: "same",
  });

  assert.notEqual(one.worktrees[1].path, two.worktrees[1].path);
  assert.equal(await exists(one.worktrees[1].path), true);
  assert.equal(await exists(two.worktrees[1].path), true);
});

test("propagates a missing git binary rather than reporting an empty catalog", async (t) => {
  const { project, worktreeRoot } = await setUp(t, "nogit");
  const previousPath = process.env.PATH;
  process.env.PATH = "/nonexistent";
  t.after(() => {
    process.env.PATH = previousPath;
  });

  await assert.rejects(
    createWorktree({ projectPath: project, worktreeRoot, name: "x" }),
    GitUnavailableError,
  );
});
