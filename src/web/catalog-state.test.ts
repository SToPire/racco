import assert from "node:assert/strict";
import test from "node:test";
import {
  catalogReducer,
  initialCatalogState,
  type CatalogData,
} from "./catalog-state.js";
import type {
  ProjectEntry,
  SessionSummary,
  WorktreeCatalog,
  WorktreeEntry,
} from "../shared/protocol.js";
const project: ProjectEntry = {
  projectId: "project",
  name: "Project",
  path: "/project",
  available: true,
  createdAt: "2026-01-01",
};
const session: SessionSummary = {
  sessionId: "one",
  projectId: "project",
  cwd: "/project",
  provider: "codex",
  updatedAt: "2026-01-01",
  state: "idle",
  lifecycle: "active",
  selectedModelSettings: null,
  contextUsage: null,
  compacting: false,
};
const worktree: WorktreeEntry = {
  projectId: "project",
  path: "/project",
  name: "Project",
  kind: "primary",
  branch: "main",
  head: "abc",
  dirty: false,
  locked: false,
  prunable: false,
  removable: false,
  sessionCount: 0,
  available: true,
};
const baseline: CatalogData = {
  projects: [project],
  sessions: [session],
  worktrees: [worktree],
  worktreeErrors: {},
};
const worktrees: WorktreeCatalog = {
  projectId: "project",
  worktrees: [worktree],
  degradedReason: null,
};

test("bootstrap replays creation, update and deletion observed while REST is pending", () => {
  let state = catalogReducer(initialCatalogState, {
    type: "begin",
    generation: 1,
  });
  state = catalogReducer(state, {
    type: "change",
    change: {
      type: "session.upserted",
      session: { ...session, sessionId: "new", state: "running" },
    },
  });
  state = catalogReducer(state, {
    type: "change",
    change: { type: "session.removed", sessionId: "one" },
  });
  state = catalogReducer(state, {
    type: "change",
    change: {
      type: "worktree.upserted",
      worktree: { ...worktree, dirty: true },
    },
  });
  state = catalogReducer(state, {
    type: "loaded",
    generation: 1,
    data: baseline,
  });
  assert.deepEqual(
    state.sessions.map((s) => s.sessionId),
    ["new"],
  );
  assert.equal(state.sessions[0].state, "running");
  assert.equal(state.worktrees[0].dirty, true);
});

test("an older overlapping refresh cannot replace the accepted newer catalog", () => {
  let state = catalogReducer(initialCatalogState, {
    type: "begin",
    generation: 1,
  });
  state = catalogReducer(state, { type: "begin", generation: 2 });
  state = catalogReducer(state, {
    type: "loaded",
    generation: 2,
    data: baseline,
  });
  assert.equal(
    catalogReducer(state, {
      type: "loaded",
      generation: 1,
      data: { ...baseline, sessions: [] },
    }),
    state,
  );
});

test("project deletion during bootstrap clears every owned slice", () => {
  let state = catalogReducer(initialCatalogState, {
    type: "begin",
    generation: 1,
  });
  state = catalogReducer(state, {
    type: "change",
    change: { type: "project.deleted", projectId: project.projectId },
  });
  state = catalogReducer(state, {
    type: "loaded",
    generation: 1,
    data: baseline,
  });
  assert.deepEqual(
    [state.projects, state.sessions, state.worktrees],
    [[], [], []],
  );
});

test("worktree refresh preserves concurrent deletion and ignores older project reads", () => {
  let state = { ...initialCatalogState, ...baseline };
  state = catalogReducer(state, {
    type: "worktree.begin",
    projectId: "project",
    generation: 1,
  });
  state = catalogReducer(state, {
    type: "worktree.begin",
    projectId: "project",
    generation: 2,
  });
  state = catalogReducer(state, {
    type: "change",
    change: { type: "worktree.deleted", path: worktree.path },
  });
  state = catalogReducer(state, {
    type: "worktree.end",
    projectId: "project",
    generation: 2,
    catalog: worktrees,
  });
  assert.deepEqual(state.worktrees, []);
  assert.equal(
    catalogReducer(state, {
      type: "worktree.end",
      projectId: "project",
      generation: 1,
      catalog: worktrees,
    }),
    state,
  );
});

test("a home refresh supersedes an older project read that completes afterwards", () => {
  let state = { ...initialCatalogState, ...baseline };
  state = catalogReducer(state, {
    type: "worktree.begin",
    projectId: "project",
    generation: 1,
  });
  state = catalogReducer(state, { type: "begin", generation: 1 });
  state = catalogReducer(state, {
    type: "loaded",
    generation: 1,
    data: { ...baseline, worktrees: [{ ...worktree, dirty: true }] },
  });
  const accepted = state;
  state = catalogReducer(state, {
    type: "worktree.end",
    projectId: "project",
    generation: 1,
    catalog: worktrees,
  });
  assert.equal(state, accepted);
  assert.equal(state.worktrees[0].dirty, true);
});

for (const completesFirst of [true, false]) {
  test(`a newer project read survives a home refresh when it completes ${completesFirst ? "before" : "after"} the home baseline`, () => {
    let state = catalogReducer(initialCatalogState, {
      type: "begin",
      generation: 1,
    });
    state = catalogReducer(state, {
      type: "worktree.begin",
      projectId: "project",
      generation: 1,
    });
    const projectRead = {
      type: "worktree.end" as const,
      projectId: "project",
      generation: 1,
      catalog: { ...worktrees, worktrees: [{ ...worktree, dirty: true }] },
    };
    if (completesFirst) state = catalogReducer(state, projectRead);
    state = catalogReducer(state, {
      type: "loaded",
      generation: 1,
      data: baseline,
    });
    if (!completesFirst) state = catalogReducer(state, projectRead);
    assert.equal(state.worktrees[0].dirty, true);
    assert.deepEqual(state.worktreeReads, {});
  });
}
