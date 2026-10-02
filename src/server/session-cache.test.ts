import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import {
  fixtureModelCatalog,
  fixtureModelSettings,
} from "../../test/model-catalog.js";
import { memoryRepository } from "../../test/state.js";
import type { SessionRef, TimelineEvent } from "../shared/protocol.js";
import type { AgentDriver, ProviderSessionUpdate } from "./drivers/driver.js";
import { IDLE_SESSION_CACHE_LIMIT, SessionHub } from "./session-hub.js";

async function fixture(t: test.TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), "racco-cache-"));
  const repository = memoryRepository();
  const project = repository.importProject({ name: "cache", path: cwd });
  let update!: (id: string, event: ProviderSessionUpdate) => void;
  const descendants = new Set<string>();
  const driver: AgentDriver & { ready: boolean } = {
    provider: "codex",
    ready: true,
    onSessionUpdate(listener) {
      update = listener;
    },
    async start() {},
    async close() {},
    async deleteSession() {},
    async listSessions() {
      return { sessions: [], nextCursor: null };
    },
    async listModels() {
      return fixtureModelCatalog();
    },
    async createSession() {
      throw new Error("unused");
    },
    async compact() {},
    hasActiveDescendants(handle) {
      return descendants.has(handle.providerSessionId);
    },
    async readSession(handle) {
      return {
        metadata: { updatedAt: "2026-09-30T00:00:00.000Z" },
        events: [
          {
            type: "assistant.message",
            id: "history",
            text: handle.providerSessionId,
          },
        ] as TimelineEvent[],
      };
    },
    async runTurn({ context, signal }) {
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      context.setState("interrupted");
    },
  };
  const hub = new SessionHub([driver], repository, cwd, async () => {});
  t.after(async () => {
    await hub.close();
    await rm(cwd, { recursive: true, force: true });
  });
  function add(id: string): SessionRef {
    return repository.importSession({
      provider: "codex",
      providerSessionId: id,
      projectId: project.projectId,
      cwd,
      updatedAt: "2026-09-30T00:00:00.000Z",
    });
  }
  async function overflow() {
    for (let i = 0; i < IDLE_SESSION_CACHE_LIMIT + 3; i++)
      await hub.snapshot(add(`idle-${i}`));
  }
  async function history(ref: SessionRef) {
    return (await hub.snapshot(ref))?.events.filter(
      (event) => event.id === "history",
    );
  }
  return {
    hub,
    driver,
    add,
    overflow,
    history,
    descendants,
    update: (id: string, event: ProviderSessionUpdate) => update(id, event),
  };
}

test("idle histories have an LRU bound, list reads do not touch it, and evicted history reloads", async (t) => {
  const f = await fixture(t);
  const first = f.add("first");
  await f.hub.snapshot(first);
  await f.overflow();
  f.hub.listSessions();
  f.driver.ready = false;
  const recent = f.add(`idle-${IDLE_SESSION_CACHE_LIMIT + 2}`);
  assert.equal((await f.history(recent))?.length, 1);
  assert.deepEqual(await f.history(first), []);
  f.driver.ready = true;
  assert.deepEqual(await f.history(first), [
    { type: "assistant.message", id: "history", text: "first" },
  ]);
});

test("turns, compaction, subscribers and both known and registering descendants pin content", async (t) => {
  const f = await fixture(t);
  const refs = ["turn", "compact", "subscribed", "child", "registering"].map(
    f.add,
  );
  for (const ref of refs) await f.hub.snapshot(ref);
  await f.hub.startTurn(
    refs[0]!,
    [{ type: "text", text: "busy" }],
    "busy",
    fixtureModelSettings,
  );
  await f.hub.compact(refs[1]!);
  const socket = {
    readyState: WebSocket.OPEN,
    send() {},
  } as unknown as WebSocket;
  await f.hub.subscribe(socket, refs[2]!);
  f.update("child", {
    type: "subagent.started",
    id: "start",
    agentId: "child-1",
  });
  f.descendants.add("registering");
  await f.overflow();
  f.driver.ready = false;
  for (const ref of refs) assert.equal((await f.history(ref))?.length, 1);

  f.hub.unregisterClient(socket);
  f.update("compact", { type: "compaction.finished" });
  f.update("child", {
    type: "subagent.state",
    id: "done",
    agentId: "child-1",
    state: "completed",
  });
  f.descendants.clear();
  f.driver.ready = true;
  await f.overflow();
  f.driver.ready = false;
  for (const ref of refs.slice(1)) assert.deepEqual(await f.history(ref), []);
  assert.equal((await f.history(refs[0]!))?.length, 1);
});

test("concurrent reads and pending subscriptions survive cache pressure until subscribed", async (t) => {
  const f = await fixture(t);
  const original = f.driver.readSession.bind(f.driver);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.mock.method(
    f.driver,
    "readSession",
    async (...args: Parameters<AgentDriver["readSession"]>) => {
      await blocked;
      return original(...args);
    },
  );
  const sockets = Array.from(
    { length: IDLE_SESSION_CACHE_LIMIT + 4 },
    () => ({ readyState: WebSocket.OPEN, send() {} }) as unknown as WebSocket,
  );
  const refs = sockets.map((_, index) => f.add(`pending-${index}`));
  const pending = sockets.map((socket, index) =>
    f.hub.subscribe(socket, refs[index]!),
  );
  await Promise.resolve();
  release();
  const snapshots = await Promise.all(pending);
  assert.ok(snapshots.every((snapshot) => snapshot?.events.length === 1));
  f.driver.ready = false;
  for (const ref of refs) assert.equal((await f.history(ref))?.length, 1);
  for (const socket of sockets) f.hub.unregisterClient(socket);
  assert.deepEqual(await f.history(refs[0]!), []);
});
