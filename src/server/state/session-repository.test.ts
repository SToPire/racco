import { fixtureModelSettings } from "../../../test/model-catalog.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { memoryRepository } from "../../../test/state.js";
import { SessionRepository } from "./session-repository.js";
import { openRaccoStateDatabase } from "./database.js";
import { CURRENT_SCHEMA_VERSION, initializeStateSchema } from "./schema.js";

test("persists managed sessions and reconciles an unfinished turn after restart", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "racco-state-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const firstState = openRaccoStateDatabase(directory);
  const first = new SessionRepository(firstState.database, firstState.close);
  const project = first.importProject({
    name: "project",
    path: "/work/project",
  });
  first.createProvisioning({
    sessionId: "racco-session",
    provider: "codex",
    projectId: project.projectId,
    cwd: "/work/project",
    title: "New Codex session",
    requestId: "create-request",
    requestHash: "create-hash",
  });
  first.recordProviderSession({
    sessionId: "racco-session",
    providerSessionId: "native-thread",
    materialized: true,
    cwd: "/work/project",
  });
  first.acceptTurn("racco-session", fixtureModelSettings, true);
  first.close();

  const secondState = openRaccoStateDatabase(directory);
  const second = new SessionRepository(secondState.database, secondState.close);
  second.recoverInterrupted();
  const restored = second.get("racco-session");
  assert.equal(restored?.providerSessionId, "native-thread");
  assert.equal(restored?.projectId, project.projectId);
  assert.equal(restored?.state, "interrupted");
  assert.deepEqual(restored?.selectedModelSettings, fixtureModelSettings);
  assert.equal(second.list().length, 1);
  second.close();
});

test("deduplicates explicit imports by provider-native ID", () => {
  const repository = memoryRepository();
  const project = repository.importProject({
    name: "project",
    path: "/work/project",
  });
  const first = repository.importSession({
    provider: "claude",
    providerSessionId: "native-session",
    projectId: project.projectId,
    cwd: "/work/project",
    title: "Imported",
    updatedAt: "2026-09-03T00:00:00.000Z",
  });
  const second = repository.importSession({
    provider: "claude",
    providerSessionId: "native-session",
    projectId: project.projectId,
    cwd: "/work/project",
    updatedAt: "2026-09-03T00:00:00.000Z",
  });

  assert.equal(second.sessionId, first.sessionId);
  assert.equal(repository.list().length, 1);
  repository.close();
});

test("rejects every non-current stored schema without modifying it", () => {
  for (const version of [
    0,
    CURRENT_SCHEMA_VERSION - 1,
    CURRENT_SCHEMA_VERSION + 1,
  ]) {
    const database = new DatabaseSync(":memory:");
    database.exec(`PRAGMA user_version = ${version}`);
    if (version === 0) database.exec("CREATE TABLE obsolete_state (id TEXT)");
    assert.throws(
      () => initializeStateSchema(database),
      /schema .* is unsupported/,
    );
    assert.equal(
      database.prepare("PRAGMA user_version").get()?.user_version,
      version,
    );
    database.close();
  }
});

test("stores session metadata without per-turn records or context readings", () => {
  const database = new DatabaseSync(":memory:");
  initializeStateSchema(database);
  const repository = new SessionRepository(database);
  const project = repository.importProject({ name: "test", path: "/test" });
  const session = repository.importSession({
    provider: "codex",
    providerSessionId: "native",
    projectId: project.projectId,
    cwd: project.path,
    updatedAt: new Date().toISOString(),
  });
  try {
    for (let i = 0; i < 3; i++) {
      repository.acceptTurn(session.sessionId, fixtureModelSettings, false);
      repository.updateExecutionState(session.sessionId, "idle");
    }
    const tables = database
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map((row) => row.name);
    assert.deepEqual(tables, ["projects", "sessions"]);
    const columns = database
      .prepare("PRAGMA table_info(sessions)")
      .all()
      .map((row) => row.name);
    assert(!columns.includes("context_usage"));
    assert(!columns.includes("health"));
    assert(!columns.includes("last_error"));
    assert.deepEqual(
      repository.get(session.sessionId)?.selectedModelSettings,
      fixtureModelSettings,
    );
    assert.equal(repository.list().length, 1);
  } finally {
    repository.close();
  }
});
