import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { WebSocket } from "ws";
import { FixtureDriver } from "../../../test/fixtures/driver.js";
import { fixtureModelSettings } from "../../../test/model-catalog.js";
import { memoryRepository } from "../../../test/state.js";
import { SessionHub } from "../session-hub.js";
import { runGit } from "./git.js";
import { WorktreeDirtyError } from "./manager.js";
import { WorktreeService } from "./service.js";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "racco-worktree-hub-"));
  const cwd = join(directory, "repo");
  const driver = new FixtureDriver("codex", join(directory, "native"));
  const repository = memoryRepository();
  const hub = new SessionHub(
    [driver],
    repository,
    join(directory, "worktrees"),
  );
  t.after(async () => {
    await hub.close();
    await rm(directory, { recursive: true, force: true });
  });
  await mkdir(cwd);
  await runGit(["init", "-q"], { cwd });
  await writeFile(join(cwd, "tracked.txt"), "initial\n");
  await runGit(["add", "-A"], { cwd });
  await runGit(
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.com",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-qm",
      "initial",
    ],
    { cwd },
  );
  await driver.start();
  const project = await hub.importProject(cwd);
  const { worktree } = await hub.createWorktree({
    projectId: project.projectId,
    name: "linked",
  });
  await driver.seed("native", "fixture", worktree.path);
  const input = {
    provider: "codex" as const,
    providerSessionId: "native",
    projectId: project.projectId,
    path: worktree.path,
  };
  const ref = await hub.importSession(input);
  const socket = { readyState: 1, send() {} } as unknown as WebSocket;
  const create = () =>
    hub.createSession(
      socket,
      "codex",
      project.projectId,
      worktree.path,
      "create",
      "wait",
      fixtureModelSettings,
    );
  return { hub, driver, repository, project, worktree, input, ref, create };
}

for (const scope of ["worktree", "project"] as const) {
  test(`${scope} deletion reserves the directory through failure and releases it for retry`, async (t) => {
    const f = await fixture(t);
    const entered = gate();
    const release = gate();
    t.after(release.resolve);
    t.mock.method(
      WorktreeService.prototype,
      scope === "worktree" ? "remove" : "removeForProject",
      async () => {
        entered.resolve();
        await release.promise;
        throw new Error("cleanup failed");
      },
    );
    const deleting = assert.rejects(
      scope === "worktree"
        ? f.hub.deleteWorktree({
            projectId: f.project.projectId,
            path: f.worktree.path,
          })
        : f.hub.deleteProject(f.project.projectId, true),
      /cleanup failed/,
    );
    await entered.promise;
    await assert.rejects(
      f.hub.startTurn(f.ref, "wait", "start", fixtureModelSettings),
      /busy/,
    );
    await assert.rejects(f.hub.compact(f.ref), /busy/);
    await assert.rejects(f.create(), /busy/);
    await assert.rejects(f.hub.importSession(f.input), /busy/);
    await assert.rejects(f.hub.deleteNativeSession(f.input), /busy/);
    if (scope === "project") {
      await assert.rejects(
        f.hub.createWorktree({
          projectId: f.project.projectId,
          name: "another",
        }),
        /busy/,
      );
    }
    release.resolve();
    await deleting;
    assert.equal(
      await f.hub.startTurn(f.ref, "wait", "retry", fixtureModelSettings),
      true,
    );
    await access(f.worktree.path);
  });
}

for (const operation of ["create", "start", "import"] as const) {
  test(`pending session ${operation} prevents worktree and project deletion`, async (t) => {
    const f = await fixture(t);
    const entered = gate();
    const release = gate();
    t.after(release.resolve);
    const method =
      operation === "create"
        ? "createSession"
        : operation === "start"
          ? "listModels"
          : "readSession";
    if (operation === "import")
      await f.driver.seed("other", "other", f.worktree.path);
    // Gate the provider boundary while the hub owns the directory reservation.
    const original = f.driver[method].bind(f.driver);
    t.mock.method(f.driver, method, async (...args: unknown[]) => {
      entered.resolve();
      await release.promise;
      return (original as (...input: unknown[]) => Promise<unknown>)(...args);
    });
    const pending =
      operation === "create"
        ? f.create()
        : operation === "start"
          ? f.hub.startTurn(f.ref, "wait", "start", fixtureModelSettings)
          : f.hub.importSession({ ...f.input, providerSessionId: "other" });
    await entered.promise;
    await assert.rejects(
      f.hub.deleteWorktree({
        projectId: f.project.projectId,
        path: f.worktree.path,
      }),
      /busy/,
    );
    await assert.rejects(f.hub.deleteProject(f.project.projectId), /busy/);
    await assert.rejects(
      f.hub.deleteProject(f.project.projectId, true),
      /busy/,
    );
    release.resolve();
    await pending;
    await access(f.worktree.path);
  });
}

for (const busy of ["running", "compacting"] as const) {
  test(`project cleanup keeps a ${busy} worktree while single deletion refuses it`, async (t) => {
    const f = await fixture(t);
    if (busy === "running") {
      await f.hub.startTurn(f.ref, "wait", "active", fixtureModelSettings);
    } else {
      t.mock.method(f.driver, "compact", async () => undefined);
      await f.hub.compact(f.ref);
    }
    await writeFile(join(f.worktree.path, "tracked.txt"), "active work\n");
    await assert.rejects(
      f.hub.deleteWorktree({
        projectId: f.project.projectId,
        path: f.worktree.path,
        force: true,
      }),
      /正在进行/,
    );
    await f.hub.deleteProject(f.project.projectId, true);
    assert.equal(f.repository.getProject(f.project.projectId), undefined);
    assert.equal(
      await readFile(join(f.worktree.path, "tracked.txt"), "utf8"),
      "active work\n",
    );
  });
}

test("hidden untracked files require force, which removes sessions and keeps the branch", async (t) => {
  const f = await fixture(t);
  await runGit(["config", "status.showUntrackedFiles", "no"], {
    cwd: f.project.path,
  });
  const file = join(f.worktree.path, "untracked.txt");
  await writeFile(file, "user work\n");
  await assert.rejects(
    f.hub.deleteWorktree({
      projectId: f.project.projectId,
      path: f.worktree.path,
    }),
    WorktreeDirtyError,
  );
  assert.equal(await readFile(file, "utf8"), "user work\n");
  const result = await f.hub.deleteWorktree({
    projectId: f.project.projectId,
    path: f.worktree.path,
    force: true,
  });
  assert.deepEqual(result.removedSessionIds, [f.ref.sessionId]);
  assert.equal(f.repository.get(f.ref.sessionId), undefined);
  await assert.rejects(access(f.worktree.path));
  assert.match(
    await runGit(["branch", "--list", "linked"], { cwd: f.project.path }),
    /linked/,
  );
});

test("an explicit branch option removes the local branch with the worktree", async (t) => {
  const f = await fixture(t);
  const result = await f.hub.deleteWorktree({
    projectId: f.project.projectId,
    path: f.worktree.path,
    deleteBranch: true,
  });

  assert.deepEqual(result.branchDeletion, {
    branch: "linked",
    deleted: true,
  });
  assert.deepEqual(result.removedSessionIds, [f.ref.sessionId]);
  assert.equal(
    (
      await runGit(["branch", "--list", "linked"], {
        cwd: f.project.path,
      })
    ).trim(),
    "",
  );
});

test("a prunable worktree can be removed without a dirty check or force", async (t) => {
  const f = await fixture(t);
  await rm(f.worktree.path, { recursive: true });
  const result = await f.hub.deleteWorktree({
    projectId: f.project.projectId,
    path: f.worktree.path,
  });
  assert.deepEqual(result.removedSessionIds, [f.ref.sessionId]);
  assert.deepEqual(
    result.catalog.worktrees.map((entry) => entry.path),
    [f.project.path],
  );
  await access(f.project.path);
});

test("a Git outage preserves the linked catalog and reports degradation until refresh", async (t) => {
  const f = await fixture(t);
  const before = await f.hub.listWorktrees(f.project.projectId);
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = "/nonexistent";
    const after = await f.hub.refreshWorktrees(f.project.projectId);
    assert.deepEqual(
      after.worktrees.map((entry) => entry.path),
      before.worktrees.map((entry) => entry.path),
    );
    assert.match(after.degradedReason ?? "", /git/);
  } finally {
    process.env.PATH = originalPath;
  }
  assert.notEqual(
    (await f.hub.listWorktrees(f.project.projectId)).degradedReason,
    null,
  );
  assert.equal(
    (await f.hub.refreshWorktrees(f.project.projectId)).degradedReason,
    null,
  );
});
