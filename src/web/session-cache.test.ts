import assert from "node:assert/strict";
import test from "node:test";
import type { SessionSummary } from "../shared/protocol.js";
import {
  forgetSessionContent,
  SESSION_CACHE_LIMIT,
  updateSessionContent,
  visitSession,
  receiveSessionSummary,
  staleSessionClocks,
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
    activeRequest: null,
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

test("cached request clocks keep their receipt anchor across navigation and await a new sample after disconnect", () => {
  const running = {
    ...session("running"),
    activeRequest: { id: "turn", elapsedMs: 12000 },
  };
  let cache = visitSession(new Map(), running);
  cache = updateSessionContent(cache, "running", (content) =>
    receiveSessionSummary(content, running, 500),
  );
  const clock = cache.get("running")!.requestClock;
  cache = visitSession(cache, session("other"));
  cache = visitSession(cache, running);
  assert.equal(cache.get("running")!.requestClock, clock);
  cache = staleSessionClocks(cache);
  assert.equal(cache.get("running")!.requestClock?.stale, true);
  assert.equal(cache.get("running")!.requestClock?.sampleElapsedMs, 12000);
  cache = updateSessionContent(cache, "running", (content) =>
    receiveSessionSummary(content, { ...running, activeRequest: null }, 10000),
  );
  assert.equal(cache.get("running")!.requestClock, null);
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
