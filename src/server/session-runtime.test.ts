import assert from "node:assert/strict";
import test from "node:test";
import { SessionRuntime } from "./session-runtime.js";
import { SessionInteractions } from "./session-interactions.js";
import type { ServerMessage, SessionSummary } from "../shared/protocol.js";
const summary: SessionSummary = {
  sessionId: "s",
  provider: "codex",
  projectId: "p",
  cwd: "/project",
  updatedAt: "2026-01-01T00:00:00.000Z",
  state: "idle",
  lifecycle: "active",
  selectedModelSettings: null,
  contextUsage: null,
  compacting: false,
};

test("a history read cannot overwrite newer live content or a new busy operation", () => {
  const runtime = new SessionRuntime(summary);
  const release = runtime.retainRead();
  const revision = runtime.revision;
  runtime.append({ type: "assistant.message", id: "live", text: "new" });
  assert.equal(runtime.replaceHistory([], revision), false);
  assert.equal(runtime.snapshotEvents().length, 1);
  release();
  release();
  assert.equal(runtime.readers, 0);
  const current = runtime.revision;
  runtime.beginTurn();
  assert.equal(runtime.replaceHistory([], current), false);
  assert.throws(() => runtime.beginTurn(), /active turn/);
  assert.throws(() => runtime.setCompacting(true), /busy/);
});

test("finishing an obsolete operation cannot clear a new turn and refresh keeps ephemeral state", () => {
  const runtime = new SessionRuntime(summary);
  runtime.setContextUsage({ usedTokens: 12, maxTokens: 100 });
  const old = runtime.beginTurn();
  assert.equal(runtime.interrupt(), true);
  assert.equal(old.abortController.signal.aborted, true);
  runtime.finishTurn(old);
  const current = runtime.beginTurn();
  runtime.finishTurn(old);
  assert.equal(runtime.activeTurn, current);
  runtime.refreshSummary({ ...summary, title: "updated", state: "running" });
  assert.equal(runtime.summary.contextUsage?.usedTokens, 12);
  assert.equal(runtime.summary.title, "updated");
});

test("question cancellation settles once and leaves sibling interactions pending", async () => {
  const changes: Array<{ event: ServerMessage; count: number }> = [];
  const interactions = new SessionInteractions((_session, event, count) =>
    changes.push({ event, count }),
  );
  const abort = new AbortController();
  const first = interactions.request(
    "s",
    { title: "first", questions: [] },
    abort.signal,
  );
  const second = interactions.request("s", { title: "second", questions: [] });
  const [firstId, secondId] = interactions
    .forSession("s")
    .map((value) => value.id);
  const rejected = assert.rejects(first, /native cancelled/);
  abort.abort(new Error("native cancelled"));
  await rejected;
  assert.equal(interactions.resolve(firstId, { decision: "deny" }), false);
  assert.deepEqual(
    interactions.forSession("s").map((value) => value.id),
    [secondId],
  );
  assert.equal(changes.at(-1)?.count, 1);
  assert.equal(
    interactions.resolve(secondId, { decision: "answer", answers: {} }),
    true,
  );
  assert.deepEqual(await second, { decision: "answer", answers: {} });
  interactions.rejectSession("s", new Error("finished"));
  assert.equal(
    changes.filter((value) => value.event.type === "interaction.resolved")
      .length,
    2,
  );
});
