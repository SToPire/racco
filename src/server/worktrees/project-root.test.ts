import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { memoryRepository } from "../../../test/state.js";
import { resolveProjectDirectory } from "../project-path.js";
import { SessionHub } from "../session-hub.js";
import { deriveWorktrees } from "./derive.js";
import { runGit } from "./git.js";

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "racco-project-root-"));
  const project = join(directory, "repo");
  await runGit(["init", "-q", project]);
  await runGit(
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.com",
      "commit",
      "--allow-empty",
      "-qm",
      "init",
    ],
    { cwd: project },
  );
  const repository = memoryRepository();
  const hub = new SessionHub(
    [],
    repository,
    join(directory, "worktrees"),
    async () => {},
  );
  t.after(async () => {
    await hub.close();
    await rm(directory, { force: true, recursive: true });
  });
  return { directory, project, repository, hub };
}

test("imports plain directories and canonical Git main roots", async (t) => {
  const f = await fixture(t);
  const plain = join(f.directory, "plain");
  const alias = join(f.directory, "repo-alias");
  await mkdir(plain);
  await symlink(f.project, alias);

  assert.equal((await f.hub.importProject(plain)).path, plain);
  const imported = await f.hub.importProject(alias);
  assert.equal(imported.path, f.project);
  assert.equal(
    (await f.hub.importProject(f.project)).projectId,
    imported.projectId,
  );
  const catalog = await f.hub.listWorktrees(imported.projectId);
  assert.deepEqual(
    catalog.worktrees.map(({ path, kind, removable }) => ({
      path,
      kind,
      removable,
    })),
    [{ path: f.project, kind: "primary", removable: false }],
  );
});

test("refuses Git subdirectories, linked roots and bare repositories before registration", async (t) => {
  const f = await fixture(t);
  const subdirectory = join(f.project, "src");
  const linked = join(f.directory, "linked");
  const bare = join(f.directory, "bare.git");
  await mkdir(subdirectory);
  await runGit(["worktree", "add", "-q", "-b", "feature", linked], {
    cwd: f.project,
  });
  await runGit(["init", "--bare", "-q", bare]);

  for (const path of [subdirectory, linked]) {
    await assert.rejects(f.hub.importProject(path), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /主工作区根目录/);
      assert.ok(error.message.includes(f.project));
      return true;
    });
    // Directory normalization remains usable by providers for session cwd.
    assert.equal(await resolveProjectDirectory(path), path);
    // A stale or externally inserted registration must not expose the real
    // main worktree as a removable linked entry either.
    await assert.rejects(
      deriveWorktrees({ projectPath: path }),
      /主工作区根目录/,
    );
  }
  await assert.rejects(f.hub.importProject(bare), /裸 Git 仓库/);
  await assert.rejects(deriveWorktrees({ projectPath: bare }), /裸 Git 仓库/);
  assert.deepEqual(f.repository.listProjects(), []);
  const main = await f.hub.importProject(f.project);
  const catalog = await f.hub.listWorktrees(main.projectId);
  assert.equal(
    catalog.worktrees.find((entry) => entry.path === f.project)?.removable,
    false,
  );
  assert.equal(
    catalog.worktrees.find((entry) => entry.path === linked)?.kind,
    "linked",
  );
});
