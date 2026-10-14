import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

test("imports linked roots through their main project and refuses subdirectories and bare repos", async (t) => {
  const f = await fixture(t);
  const subdirectory = join(f.project, "src");
  const linked = join(f.directory, "linked");
  const bare = join(f.directory, "bare.git");
  await mkdir(subdirectory);
  await runGit(["worktree", "add", "-q", "-b", "feature", linked], {
    cwd: f.project,
  });
  await runGit(["init", "--bare", "-q", bare]);
  const linkedSubdirectory = join(linked, "src");
  await mkdir(linkedSubdirectory);

  for (const path of [subdirectory, linkedSubdirectory]) {
    await assert.rejects(f.hub.importProject(path), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /worktree root directory/);
      assert.ok(error.message.includes(dirname(path)));
      return true;
    });
    // Directory normalization remains usable by providers for session cwd.
    assert.equal(await resolveProjectDirectory(path), path);
    // A stale or externally inserted registration must not expose the real
    // main worktree as a removable linked entry either.
    await assert.rejects(
      deriveWorktrees({ projectPath: path }),
      /worktree root directory/,
    );
  }
  await assert.rejects(f.hub.importProject(bare), /Bare Git repositories/);
  await assert.rejects(
    deriveWorktrees({ projectPath: bare }),
    /Bare Git repositories/,
  );
  assert.deepEqual(f.repository.listProjects(), []);
  await assert.rejects(
    deriveWorktrees({ projectPath: linked }),
    /main worktree root/,
  );
  const main = await f.hub.importProject(linked);
  assert.equal(main.path, f.project);
  assert.equal(
    (await f.hub.importProject(f.project)).projectId,
    main.projectId,
  );
  assert.equal((await f.hub.importProject(linked)).projectId, main.projectId);
  assert.equal(f.repository.listProjects().length, 1);
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

test("concurrent main and linked imports register one main project", async (t) => {
  const f = await fixture(t);
  const linked = join(f.directory, "linked");
  await runGit(["worktree", "add", "-q", "-b", "feature", linked], {
    cwd: f.project,
  });
  const [main, redirected] = await Promise.all([
    f.hub.importProject(f.project),
    f.hub.importProject(linked),
  ]);
  assert.equal(main.projectId, redirected.projectId);
  assert.equal(redirected.path, f.project);
  assert.equal(f.repository.listProjects().length, 1);
});

test("linked import fails if its main working directory is missing", async (t) => {
  const f = await fixture(t);
  const linked = join(f.directory, "linked");
  await runGit(["worktree", "add", "-q", "-b", "feature", linked], {
    cwd: f.project,
  });
  assert.equal((await f.hub.importProject(linked)).path, f.project);
  const imported = f.repository.listProjects()[0];
  await rm(f.project, { recursive: true });
  await assert.rejects(f.hub.importProject(linked), /not a git repository/);
  assert.equal(f.repository.listProjects().length, 1);
  assert.equal(f.repository.listProjects()[0].projectId, imported.projectId);
});
