import assert from "node:assert/strict";
import test from "node:test";
import type { SessionSummary } from "../shared/protocol.js";
import { upsertSession } from "./catalog.js";

function session(
  sessionId: string,
  updatedAt: string,
  state: SessionSummary["state"] = "idle",
): SessionSummary {
  return {
    sessionId,
    provider: "codex",
    projectId: "project-1",
    cwd: "/work/project-1",
    updatedAt,
    state,
    lifecycle: "active",
    selectedModelSettings: null,
    contextUsage: null,
    compacting: false,
  };
}

test("inserts new sessions immediately and keeps the newest first", () => {
  const result = upsertSession(
    [session("older", "2026-09-03T00:00:00.000Z")],
    session("newer", "2026-09-03T00:01:00.000Z"),
  );

  assert.deepEqual(
    result.map((candidate) => candidate.sessionId),
    ["newer", "older"],
  );
});

test("replaces catalog sessions without creating duplicates", () => {
  const result = upsertSession(
    [session("same", "2026-09-03T00:00:00.000Z")],
    session("same", "2026-09-03T00:01:00.000Z", "running"),
  );

  assert.equal(result.length, 1);
  assert.equal(result[0]?.state, "running");
});
