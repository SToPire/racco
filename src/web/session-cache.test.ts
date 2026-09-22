import assert from "node:assert/strict";
import test from "node:test";
import type { SessionSummary } from "../shared/protocol.js";
import {
  forgetSessionContent,
  SESSION_CACHE_LIMIT,
  updateSessionContent,
  visitSession,
  type SessionCache,
} from "./session-cache.js";

function session(id: string): SessionSummary {
  return {
    sessionId: id,
    projectId: id === "keep" ? "keep-project" : "project",
    provider: "codex",
    title: id,
    cwd: "/repo",
    state: "idle",
    lifecycle: "active",
    selectedModelSettings: null,
    contextUsage: null,
    compacting: false,
    updatedAt: "2026-09-22T00:00:00.000Z",
  };
}

test("returning to a cached session preserves its content and evicts the least recently visited view", () => {
  let cache: SessionCache = new Map();
  for (let index = 0; index < SESSION_CACHE_LIMIT; index++)
    cache = visitSession(cache, session(String(index)));
  cache = updateSessionContent(cache, "0", (content) => ({
    ...content,
    loaded: true,
    rows: [{ type: "assistant.message", id: "reply", text: "cached" }],
  }));
  const content = cache.get("0");
  cache = visitSession(cache, session("0"));
  cache = visitSession(cache, session("extra"));
  assert.equal(cache.get("0"), content);
  assert.equal(cache.has("1"), false);
  assert.equal(cache.size, SESSION_CACHE_LIMIT);
  assert.equal(
    updateSessionContent(cache, "1", () =>
      assert.fail("late snapshots must not resurrect evicted views"),
    ),
    cache,
  );
});

test("removing a project discards its cached messages and questions without touching other projects", () => {
  let cache = visitSession(
    visitSession(new Map(), session("remove")),
    session("keep"),
  );
  cache = forgetSessionContent(
    cache,
    (content) => content.session.projectId === "project",
  );
  assert.deepEqual([...cache.keys()], ["keep"]);
});
