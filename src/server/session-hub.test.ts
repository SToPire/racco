import {
  fixtureModelCatalog,
  fixtureModelSettings,
} from "../../test/model-catalog.js";
import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { memoryRepository } from "../../test/state.js";
import { WebSocket } from "ws";
import type { ServerMessage, TimelineEvent } from "../shared/protocol.js";
import { buildTimeline } from "../web/store.js";
import type { AgentDriver, SessionSnapshot } from "./drivers/driver.js";
import { SessionHub } from "./session-hub.js";
import type { SessionRepository } from "./state/session-repository.js";

function recordingSocket(sent: ServerMessage[] = []): WebSocket {
  return {
    readyState: WebSocket.OPEN,
    send(value: string) {
      sent.push(JSON.parse(value));
    },
  } as WebSocket;
}

async function fixtureCwd(): Promise<string> {
  return realpath(process.cwd());
}

function fixtureProjectId(repository: SessionRepository, cwd: string): string {
  return repository.importProject({ name: "fixture", path: cwd }).projectId;
}

async function modelTestHub() {
  const cwd = await fixtureCwd();
  const repository = memoryRepository();
  const projectId = fixtureProjectId(repository, cwd);
  const received: Array<
    Parameters<AgentDriver["runTurn"]>[0]["modelSettings"]
  > = [];
  let allocations = 0;
  let ready = true;
  const driver: AgentDriver = {
    provider: "codex",
    get ready() {
      return ready;
    },
    onSessionUpdate() {},
    async start() {},
    async close() {},
    async listSessions() {
      return { sessions: [], nextCursor: null };
    },
    async listModels() {
      return fixtureModelCatalog();
    },
    async readSession() {
      return { metadata: { updatedAt: new Date().toISOString() }, events: [] };
    },
    async deleteSession() {
      throw new Error("deleteSession not expected");
    },
    async createSession() {
      allocations++;
      return {
        providerSessionId: `native-${allocations}`,
        cwd,
        materialized: true,
      };
    },
    async runTurn({ modelSettings, signal, context }) {
      received.push(modelSettings);
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      context.setState("interrupted");
    },
  };
  const hub = new SessionHub([driver], repository);
  return {
    hub,
    driver,
    repository,
    projectId,
    received,
    allocations: () => allocations,
    setReady: (value: boolean) => {
      ready = value;
    },
    socket: recordingSocket(),
  };
}

test("rejects invalid model/effort pairs before allocating a native session", async () => {
  const f = await modelTestHub();
  try {
    await assert.rejects(
      f.hub.createSession(f.socket, "codex", f.projectId, "bad", "task", {
        modelId: "fixture-fast",
        reasoningEffort: "xhigh",
      }),
      /不可选/,
    );
    assert.equal(f.allocations(), 0);
    assert.equal(f.repository.list().length, 0);
  } finally {
    await f.hub.close();
  }
});

test("broadcasts withdrawn and stopped text and replays it consistently on reconnect", async () => {
  const f = await modelTestHub();
  const firstMessages: ServerMessage[] = [];
  const secondMessages: ServerMessage[] = [];
  let emit!: (event: TimelineEvent) => void;
  f.driver.runTurn = async ({ context, signal }) => {
    emit = context.emit;
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    context.setState("interrupted");
  };
  const timelineEvents = (messages: ServerMessage[]) =>
    messages.flatMap((message) =>
      message.type === "timeline.event" ? [message.event] : [],
    );
  try {
    const { ref } = await f.hub.createSession(
      recordingSocket(firstMessages),
      "codex",
      f.projectId,
      "stream-lifecycle",
      "hello",
      fixtureModelSettings,
    );
    await f.hub.startTurn(
      ref,
      "hello",
      "create:stream-lifecycle",
      fixtureModelSettings,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    emit({
      type: "assistant.message",
      id: "abandoned",
      text: "Discard this partial",
      partial: true,
    });
    const joined = await f.hub.subscribe(recordingSocket(secondMessages), ref);
    assert(joined);
    emit({ type: "assistant.message.removed", id: "abandoned" });
    emit({
      type: "assistant.message",
      id: "retry",
      text: "Keep this partial",
      partial: true,
    });
    emit({
      type: "assistant.message",
      id: "retry",
      text: "Keep this partial",
      stopReason: "interrupted",
    });
    const reconnect = await f.hub.snapshot(ref);
    assert(reconnect);
    const expected = buildTimeline(reconnect.events);
    assert.deepEqual(buildTimeline(timelineEvents(firstMessages)), expected);
    assert.deepEqual(
      buildTimeline([...joined.events, ...timelineEvents(secondMessages)]),
      expected,
    );
    assert.deepEqual(
      expected.filter((row) => row.type === "assistant.message"),
      [
        {
          type: "assistant.message",
          id: "retry",
          text: "Keep this partial",
          stopReason: "interrupted",
        },
      ],
    );
  } finally {
    await f.hub.close();
  }
});

test("coalesces creation and binds accepted requests to both model and effort", async () => {
  const f = await modelTestHub();
  try {
    const create = () =>
      f.hub.createSession(
        f.socket,
        "codex",
        f.projectId,
        "same",
        "task",
        fixtureModelSettings,
      );
    const [first, second] = await Promise.all([create(), create()]);
    assert.deepEqual(first.ref, second.ref);
    assert.equal(f.allocations(), 1);
    assert.equal(
      f.repository.get(first.ref.sessionId)?.selectedModelSettings,
      null,
    );
    assert.equal(
      f.repository.get(first.ref.sessionId)?.lifecycle,
      "provisioning",
    );
    const starts = await Promise.all([
      f.hub.startTurn(first.ref, "task", "create:same", fixtureModelSettings),
      f.hub.startTurn(first.ref, "task", "create:same", fixtureModelSettings),
    ]);
    assert.deepEqual(starts.sort(), [false, true]);
    assert.deepEqual(f.received, [fixtureModelSettings]);
    assert.deepEqual(
      f.repository.get(first.ref.sessionId)?.selectedModelSettings,
      fixtureModelSettings,
    );
    await assert.rejects(
      f.hub.startTurn(first.ref, "task", "create:same", {
        ...fixtureModelSettings,
        reasoningEffort: "xhigh",
      }),
      /Initial turn does not match/,
    );
    await assert.rejects(
      f.hub.createSession(
        f.socket,
        "codex",
        f.projectId,
        "same",
        "changed task",
        fixtureModelSettings,
      ),
      /different parameters/,
    );
    f.setReady(false);
    assert.equal(
      await f.hub.startTurn(
        first.ref,
        "task",
        "create:same",
        fixtureModelSettings,
      ),
      false,
    );
    await create(); // Acknowledging an accepted request does not need a live catalog.
  } finally {
    await f.hub.close();
  }
});

test("a provisioning session with a native ID can complete after recovery without allocation", async () => {
  const f = await modelTestHub();
  try {
    const created = await f.hub.createSession(
      f.socket,
      "codex",
      f.projectId,
      "recover",
      "task",
      fixtureModelSettings,
    );
    await f.hub.initialize();
    assert.equal(
      f.repository.get(created.ref.sessionId)?.lifecycle,
      "provisioning",
    );
    const replay = await f.hub.createSession(
      f.socket,
      "codex",
      f.projectId,
      "recover",
      "task",
      fixtureModelSettings,
    );
    assert.deepEqual(replay.ref, created.ref);
    assert.equal(f.allocations(), 1);
    await f.hub.startTurn(
      replay.ref,
      "task",
      "create:recover",
      fixtureModelSettings,
    );
    assert.deepEqual(
      f.repository.get(replay.ref.sessionId)?.selectedModelSettings,
      fixtureModelSettings,
    );
  } finally {
    await f.hub.close();
  }
});

test("competing clients cannot combine settings or start concurrent turns", async () => {
  const f = await modelTestHub();
  try {
    const session = await f.hub.importSession({
      provider: "codex",
      projectId: f.projectId,
      providerSessionId: "imported",
    });
    const alternate = { modelId: "fixture-fast", reasoningEffort: "medium" };
    const results = await Promise.allSettled([
      f.hub.startTurn(session, "a", "client-a", fixtureModelSettings),
      f.hub.startTurn(session, "b", "client-b", alternate),
    ]);
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assert.equal(f.received.length, 1);
    assert.deepEqual(
      f.repository.get(session.sessionId)?.selectedModelSettings,
      f.received[0],
    );
    f.hub.interrupt(session);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await f.hub.startTurn(session, "next", "next", alternate);
    assert.deepEqual(f.received[1], alternate);
    assert.deepEqual(
      f.repository.get(session.sessionId)?.selectedModelSettings,
      alternate,
    );
  } finally {
    await f.hub.close();
  }
});

test("publishes idle only after the active turn is cleared", async () => {
  const sent: ServerMessage[] = [];
  const socket = recordingSocket(sent);
  const cwd = await fixtureCwd();
  const repository = memoryRepository();
  const driver: AgentDriver = {
    provider: "claude",
    ready: true,
    async listSessions() {
      return { sessions: [], nextCursor: null };
    },
    async listModels() {
      return fixtureModelCatalog();
    },
    onSessionUpdate() {},
    async start() {},
    async close() {},
    async readSession() {
      return {
        metadata: { updatedAt: "2026-09-03T00:00:00.000Z", title: "Session" },
        events: [],
      };
    },
    async deleteSession() {
      throw new Error("deleteSession not expected");
    },
    async createSession() {
      return {
        providerSessionId: "native-session-1",
        cwd,
        materialized: true,
      };
    },
    async runTurn({ context }) {
      context.setState("idle");
    },
  };
  const hub = new SessionHub([driver], repository);
  hub.registerClient(socket);
  const created = await hub.createSession(
    socket,
    "claude",
    fixtureProjectId(repository, cwd),
    "create-1",
    "first",
    fixtureModelSettings,
  );

  sent.length = 0;
  await hub.startTurn(
    created.ref,
    "first",
    "create:create-1",
    fixtureModelSettings,
  );
  assert.equal(
    sent.some(
      (message) =>
        message.type === "session.upserted" && message.session.state === "idle",
    ),
    false,
  );

  await new Promise<void>((resolve) => setImmediate(resolve));
  await assert.doesNotReject(
    async () =>
      await hub.startTurn(
        created.ref,
        "second",
        "turn-2",
        fixtureModelSettings,
      ),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(repository.get(created.ref.sessionId)?.state, "idle");
  await hub.close();
});

test("publishes the accepted user message before the provider responds", async () => {
  const sent: ServerMessage[] = [];
  const socket = recordingSocket(sent);
  const cwd = await fixtureCwd();
  const repository = memoryRepository();
  let finishTurn!: () => void;
  const turnDone = new Promise<void>((resolve) => {
    finishTurn = resolve;
  });
  const driver: AgentDriver = {
    provider: "codex",
    ready: true,
    async listSessions() {
      return { sessions: [], nextCursor: null };
    },
    async listModels() {
      return fixtureModelCatalog();
    },
    onSessionUpdate() {},
    async start() {},
    async close() {},
    async readSession() {
      return {
        metadata: { updatedAt: "2026-09-03T00:00:00.000Z" },
        events: [],
      };
    },
    async deleteSession() {
      throw new Error("deleteSession not expected");
    },
    async createSession() {
      return {
        providerSessionId: "native-immediate-user",
        cwd,
        materialized: true,
      };
    },
    async runTurn({ context }) {
      await turnDone;
      context.emit({
        type: "user.message",
        id: "provider-user",
        text: "hello",
      });
      context.emit({
        type: "assistant.message",
        id: "assistant",
        text: "done",
      });
      context.setState("idle");
    },
  };
  const hub = new SessionHub([driver], repository);
  const created = await hub.createSession(
    socket,
    "codex",
    fixtureProjectId(repository, cwd),
    "create-immediate-user",
    "hello",
    fixtureModelSettings,
  );
  sent.length = 0;

  await hub.startTurn(
    created.ref,
    "hello",
    "create:create-immediate-user",
    fixtureModelSettings,
  );

  const immediateEvents = sent.filter(
    (message) => message.type === "timeline.event",
  );
  assert.deepEqual(
    immediateEvents.map((message) => message.event),
    [
      {
        type: "user.message",
        id: immediateEvents[0]!.event.id,
        text: "hello",
      },
    ],
  );

  finishTurn();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const allEvents = sent.filter((message) => message.type === "timeline.event");
  assert.equal(
    allEvents.filter((message) => message.event.type === "user.message").length,
    1,
  );
  await hub.close();
});

test("does not overwrite live events when a targeted provider read races with a turn", async () => {
  const cwd = await fixtureCwd();
  const repository = memoryRepository();
  let finishRead!: (value: SessionSnapshot) => void;
  const readResult = new Promise<SessionSnapshot>((resolve) => {
    finishRead = resolve;
  });
  let finishTurn!: () => void;
  const turnDone = new Promise<void>((resolve) => {
    finishTurn = resolve;
  });
  const driver: AgentDriver = {
    provider: "claude",
    ready: true,
    async listSessions() {
      return { sessions: [], nextCursor: null };
    },
    async listModels() {
      return fixtureModelCatalog();
    },
    onSessionUpdate() {},
    async start() {},
    async close() {},
    async readSession() {
      return readResult;
    },
    async deleteSession() {
      throw new Error("deleteSession not expected");
    },
    async createSession() {
      return {
        providerSessionId: "native-race",
        cwd,
        materialized: true,
      };
    },
    async runTurn({ context }) {
      context.emit({ type: "assistant.message", id: "live", text: "live" });
      await turnDone;
      context.setState("idle");
    },
  };
  const hub = new SessionHub([driver], repository);
  const imported = repository.importSession({
    provider: "claude",
    providerSessionId: "native-race",
    projectId: fixtureProjectId(repository, cwd),
    cwd,
    updatedAt: "2026-09-03T00:00:00.000Z",
  });
  const created = { ref: { sessionId: imported.sessionId } };
  const pendingSnapshot = hub.snapshot(created.ref);

  await hub.startTurn(
    created.ref,
    "race",
    "create:create-race",
    fixtureModelSettings,
  );
  finishRead({
    metadata: { updatedAt: "2026-09-03T00:00:00.000Z", title: "Stale" },
    events: [
      {
        type: "system.notice",
        id: "stale",
        text: "stale",
        level: "info",
      },
    ],
  });

  const snapshot = await pendingSnapshot;
  assert(snapshot?.type === "session.snapshot");
  assert.equal(snapshot.events.length, 2);
  assert(snapshot.events[0]?.type === "user.message");
  assert.equal(snapshot.events[0].text, "race");
  assert.deepEqual(snapshot.events[1], {
    type: "assistant.message",
    id: "live",
    text: "live",
  });
  assert.equal(
    snapshot.events.some((event) => event.id === "stale"),
    false,
  );

  finishTurn();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await hub.close();
});

test("keeps an allocated session readable without scanning provider history", async () => {
  const socket = recordingSocket();
  const cwd = await fixtureCwd();
  const repository = memoryRepository();
  let reads = 0;
  const driver: AgentDriver = {
    provider: "claude",
    ready: true,
    async listSessions() {
      return { sessions: [], nextCursor: null };
    },
    async listModels() {
      return fixtureModelCatalog();
    },
    onSessionUpdate() {},
    async start() {},
    async close() {},
    async readSession() {
      reads += 1;
      throw new Error("unmaterialized session must not be read");
    },
    async deleteSession() {
      throw new Error("deleteSession not expected");
    },
    async createSession() {
      return {
        providerSessionId: "native-pending",
        cwd,
        materialized: false,
      };
    },
    async runTurn() {},
  };
  const hub = new SessionHub([driver], repository);
  const created = await hub.createSession(
    socket,
    "claude",
    fixtureProjectId(repository, cwd),
    "create-pending",
    "initial",
    fixtureModelSettings,
  );

  const snapshot = await hub.snapshot(created.ref);
  assert.equal(snapshot?.type, "session.snapshot");
  assert.equal(reads, 0);
  assert.notEqual(created.ref.sessionId, "native-pending");
  await hub.close();
});

test("rejects unregistered Racco IDs before calling a provider", async () => {
  const repository = memoryRepository();
  let reads = 0;
  const driver: AgentDriver = {
    provider: "claude",
    ready: true,
    async listSessions() {
      return { sessions: [], nextCursor: null };
    },
    async listModels() {
      return fixtureModelCatalog();
    },
    onSessionUpdate() {},
    async start() {},
    async close() {},
    async readSession() {
      reads += 1;
      return {
        metadata: { updatedAt: "2026-09-03T00:00:00.000Z" },
        events: [],
      };
    },
    async deleteSession() {
      throw new Error("deleteSession not expected");
    },
    async createSession() {
      throw new Error("not used");
    },
    async runTurn() {},
  };
  const hub = new SessionHub([driver], repository);

  assert.equal(
    await hub.snapshot({ sessionId: "native-or-unknown-id" }),
    undefined,
  );
  assert.equal(reads, 0);
  assert.deepEqual(hub.listSessions(), []);
  await hub.close();
});

test("repairs an allocated session with a targeted startup lookup", async () => {
  const cwd = await fixtureCwd();
  const repository = memoryRepository();
  let reads = 0;
  const driver: AgentDriver = {
    provider: "claude",
    ready: true,
    async listSessions() {
      return { sessions: [], nextCursor: null };
    },
    async listModels() {
      return fixtureModelCatalog();
    },
    onSessionUpdate() {},
    async start() {},
    async close() {},
    async readSession(handle) {
      reads += 1;
      assert.equal(handle.cwd, cwd);
      assert.equal(handle.providerSessionId, "native-recovered");
      return {
        metadata: { updatedAt: "2026-09-03T00:00:00.000Z", title: "Recovered" },
        events: [],
      };
    },
    async deleteSession() {
      throw new Error("deleteSession not expected");
    },
    async createSession() {
      return {
        providerSessionId: "native-recovered",
        cwd,
        materialized: false,
      };
    },
    async runTurn() {},
  };
  const hub = new SessionHub([driver], repository);
  const created = await hub.createSession(
    recordingSocket(),
    "claude",
    fixtureProjectId(repository, cwd),
    "create-recovered",
    "initial",
    fixtureModelSettings,
  );

  await hub.startTurn(
    created.ref,
    "initial",
    "create:create-recovered",
    fixtureModelSettings,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  await hub.initialize();

  assert.equal(reads, 1);
  assert.equal(
    repository.get(created.ref.sessionId)?.providerState,
    "materialized",
  );
  assert.equal(repository.get(created.ref.sessionId)?.title, "Recovered");
  await hub.close();
});

test("does not resubmit an initial message for an already activated session", async () => {
  const cwd = await fixtureCwd();
  const repository = memoryRepository();
  let finishTurn!: () => void;
  const turnDone = new Promise<void>((resolve) => {
    finishTurn = resolve;
  });
  const driver: AgentDriver = {
    provider: "claude",
    ready: true,
    async listSessions() {
      return { sessions: [], nextCursor: null };
    },
    async listModels() {
      return fixtureModelCatalog();
    },
    onSessionUpdate() {},
    async start() {},
    async close() {},
    async readSession() {
      return {
        metadata: { updatedAt: "2026-09-03T00:00:00.000Z" },
        events: [],
      };
    },
    async deleteSession() {
      throw new Error("deleteSession not expected");
    },
    async createSession() {
      return {
        providerSessionId: "native-idempotent",
        cwd,
        materialized: true,
      };
    },
    async runTurn({ context }) {
      await turnDone;
      context.setState("idle");
    },
  };
  const hub = new SessionHub([driver], repository);
  const created = await hub.createSession(
    recordingSocket(),
    "claude",
    fixtureProjectId(repository, cwd),
    "create-idempotent",
    "hello",
    fixtureModelSettings,
  );

  assert.equal(
    await hub.startTurn(
      created.ref,
      "hello",
      "create:create-idempotent",
      fixtureModelSettings,
    ),
    true,
  );
  assert.equal(
    await hub.startTurn(
      created.ref,
      "hello",
      "create:create-idempotent",
      fixtureModelSettings,
    ),
    false,
  );
  await assert.rejects(
    async () =>
      await hub.startTurn(
        created.ref,
        "different",
        "another-turn-request",
        fixtureModelSettings,
      ),
    /active turn/,
  );

  finishTurn();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await hub.close();
});

test("imports only the explicitly requested native session and deduplicates it", async () => {
  const cwd = await fixtureCwd();
  const repository = memoryRepository();
  const handles: Array<{ providerSessionId: string; cwd: string }> = [];
  const driver: AgentDriver = {
    provider: "codex",
    ready: true,
    async listSessions() {
      return { sessions: [], nextCursor: null };
    },
    async listModels() {
      return fixtureModelCatalog();
    },
    onSessionUpdate() {},
    async start() {},
    async close() {},
    async readSession(handle) {
      handles.push(handle);
      return {
        metadata: {
          updatedAt: "2026-09-03T00:00:00.000Z",
          title: "Imported thread",
        },
        events: [{ type: "user.message", id: "user-1", text: "hello" }],
      };
    },
    async deleteSession() {
      throw new Error("deleteSession not expected");
    },
    async createSession() {
      throw new Error("not used");
    },
    async runTurn() {},
  };
  const hub = new SessionHub([driver], repository);
  const projectId = fixtureProjectId(repository, cwd);

  const first = await hub.importSession({
    provider: "codex",
    providerSessionId: "native-import",
    projectId,
  });
  const second = await hub.importSession({
    provider: "codex",
    providerSessionId: "native-import",
    projectId,
  });

  assert.equal(first.sessionId, second.sessionId);
  assert.deepEqual(handles, [{ providerSessionId: "native-import", cwd }]);
  assert.equal(hub.listSessions().length, 1);
  await hub.close();
});

test("persists an active turn as interrupted during graceful shutdown", async () => {
  const cwd = await fixtureCwd();
  const database = new DatabaseSync(":memory:");
  const repository = memoryRepository(database, () => {});
  const driver: AgentDriver = {
    provider: "codex",
    ready: true,
    async listSessions() {
      return { sessions: [], nextCursor: null };
    },
    async listModels() {
      return fixtureModelCatalog();
    },
    onSessionUpdate() {},
    async start() {},
    async close() {},
    async readSession() {
      return {
        metadata: { updatedAt: "2026-09-03T00:00:00.000Z" },
        events: [],
      };
    },
    async deleteSession() {
      throw new Error("deleteSession not expected");
    },
    async createSession() {
      return {
        providerSessionId: "native-shutdown",
        cwd,
        materialized: true,
      };
    },
    async runTurn({ signal }) {
      await new Promise<void>((_resolve, reject) => {
        const fail = () => reject(new Error("provider closed"));
        signal.addEventListener("abort", fail, { once: true });
        if (signal.aborted) fail();
      });
    },
  };
  const hub = new SessionHub([driver], repository);
  const created = await hub.createSession(
    recordingSocket(),
    "codex",
    fixtureProjectId(repository, cwd),
    "create-shutdown",
    "wait",
    fixtureModelSettings,
  );
  await hub.startTurn(
    created.ref,
    "wait",
    "create:create-shutdown",
    fixtureModelSettings,
  );

  await hub.close();

  assert.equal(repository.get(created.ref.sessionId)?.state, "interrupted");
  database.close();
});

test("imports canonical projects into the database without scanning a parent", async () => {
  const cwd = await fixtureCwd();
  const repository = memoryRepository();
  const hub = new SessionHub([], repository);

  const first = await hub.importProject(cwd);
  const second = await hub.importProject(cwd);

  assert.equal(first.projectId, second.projectId);
  assert.equal(first.path, cwd);
  assert.deepEqual(hub.listProjects(), [first]);
  await hub.close();
});

test("rejects session creation unless the project is already imported", async () => {
  const cwd = await fixtureCwd();
  const repository = memoryRepository();
  let creates = 0;
  const driver: AgentDriver = {
    provider: "codex",
    ready: true,
    async listSessions() {
      return { sessions: [], nextCursor: null };
    },
    async listModels() {
      return fixtureModelCatalog();
    },
    onSessionUpdate() {},
    async start() {},
    async close() {},
    async readSession() {
      return {
        metadata: { updatedAt: "2026-09-03T00:00:00.000Z" },
        events: [],
      };
    },
    async deleteSession() {
      throw new Error("deleteSession not expected");
    },
    async createSession() {
      creates += 1;
      return { providerSessionId: "unexpected", cwd, materialized: true };
    },
    async runTurn() {},
  };
  const hub = new SessionHub([driver], repository);

  await assert.rejects(
    hub.createSession(
      recordingSocket(),
      "codex",
      "unknown-project",
      "create-unknown",
      "initial",
      fixtureModelSettings,
    ),
    /Project not found/,
  );
  assert.equal(creates, 0);
  await hub.close();
});

test("broadcasts a real session turn to every subscribed client", async () => {
  const cwd = await fixtureCwd();
  const repository = memoryRepository();
  const sentA: ServerMessage[] = [];
  const sentB: ServerMessage[] = [];
  const socketA = recordingSocket(sentA);
  const socketB = recordingSocket(sentB);
  const driver: AgentDriver = {
    provider: "codex",
    ready: true,
    async listSessions() {
      return { sessions: [], nextCursor: null };
    },
    async listModels() {
      return fixtureModelCatalog();
    },
    onSessionUpdate() {},
    async start() {},
    async close() {},
    async readSession() {
      return {
        metadata: { updatedAt: "2026-09-03T00:00:00.000Z" },
        events: [],
      };
    },
    async deleteSession() {
      throw new Error("deleteSession not expected");
    },
    async createSession() {
      return { providerSessionId: "native-shared", cwd, materialized: true };
    },
    async runTurn({ context }) {
      context.emit({ type: "user.message", id: "user-shared", text: "hello" });
      context.emit({
        type: "assistant.message",
        id: "agent-shared",
        text: "done",
      });
      context.setState("idle");
    },
  };
  const hub = new SessionHub([driver], repository);
  const created = await hub.createSession(
    socketA,
    "codex",
    fixtureProjectId(repository, cwd),
    "create-shared",
    "hello",
    fixtureModelSettings,
  );
  await hub.subscribe(socketB, created.ref);
  sentA.length = 0;
  sentB.length = 0;

  await hub.startTurn(
    created.ref,
    "hello",
    "create:create-shared",
    fixtureModelSettings,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));

  for (const sent of [sentA, sentB]) {
    const events = sent.filter((message) => message.type === "timeline.event");
    assert.equal(events.length, 2);
  }
  await hub.close();
});

test("broadcasts project and session catalog updates to every connected client", async () => {
  const cwd = await fixtureCwd();
  const repository = memoryRepository();
  const sentA: ServerMessage[] = [];
  const sentB: ServerMessage[] = [];
  const socketA = recordingSocket(sentA);
  const socketB = recordingSocket(sentB);
  const driver: AgentDriver = {
    provider: "codex",
    ready: true,
    async listSessions() {
      return { sessions: [], nextCursor: null };
    },
    async listModels() {
      return fixtureModelCatalog();
    },
    onSessionUpdate() {},
    async start() {},
    async close() {},
    async readSession() {
      return {
        metadata: { updatedAt: "2026-09-03T00:00:00.000Z" },
        events: [],
      };
    },
    async deleteSession() {
      throw new Error("deleteSession not expected");
    },
    async createSession() {
      return { providerSessionId: "native-catalog", cwd, materialized: true };
    },
    async runTurn({ context }) {
      await context.requestInteraction({
        title: "Choose a target",
        questions: [{ id: "target", text: "Which target?", multiple: false }],
      });
      context.setState("idle");
    },
  };
  const hub = new SessionHub([driver], repository);
  hub.registerClient(socketA);
  hub.registerClient(socketB);

  const project = await hub.importProject(cwd);
  for (const sent of [sentA, sentB]) {
    assert.equal(
      sent.some(
        (message) =>
          message.type === "project.upserted" &&
          message.project.projectId === project.projectId,
      ),
      true,
    );
  }

  sentA.length = 0;
  sentB.length = 0;
  const created = await hub.createSession(
    socketA,
    "codex",
    project.projectId,
    "create-catalog",
    "hello",
    fixtureModelSettings,
  );
  for (const sent of [sentA, sentB]) {
    assert.equal(
      sent.some(
        (message) =>
          message.type === "session.upserted" &&
          message.session.sessionId === created.ref.sessionId,
      ),
      true,
    );
  }

  sentA.length = 0;
  sentB.length = 0;
  await hub.startTurn(
    created.ref,
    "hello",
    "create:create-catalog",
    fixtureModelSettings,
  );
  const interaction = sentA.find(
    (message) => message.type === "interaction.requested",
  );
  assert(interaction?.type === "interaction.requested");
  assert.equal(
    hub.resolveInteraction(interaction.interaction.id, {
      decision: "answer",
      answers: { target: ["test"] },
    }),
    true,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  for (const sent of [sentA, sentB]) {
    assert.deepEqual(
      sent
        .filter((message) => message.type === "session.upserted")
        .map((message) => message.session.state),
      ["running", "waiting_interaction", "running", "idle"],
    );
  }
  await hub.close();
});

test("compaction keeps a shared busy flag until completion without database writes", async () => {
  const f = await modelTestHub();
  // Construct the hub after registering the driver's notification hook.
  let notify!: Parameters<AgentDriver["onSessionUpdate"]>[0];
  f.driver.onSessionUpdate = (listener) => {
    notify = listener;
  };
  const hub = new SessionHub([f.driver], f.repository);
  let calls = 0;
  f.driver.compact = async () => {
    calls++;
  };
  try {
    const ref = await hub.importSession({
      provider: "codex",
      providerSessionId: "native",
      projectId: f.projectId,
    });
    const sent: ServerMessage[] = [];
    const socket = recordingSocket(sent);
    hub.registerClient(socket);
    await hub.subscribe(socket, ref);
    const beforeCompact = f.repository.get(ref.sessionId);
    await hub.compact(ref);
    await assert.rejects(hub.compact(ref), /busy/);
    await assert.rejects(
      hub.startTurn(ref, "blocked", "while-compacting", fixtureModelSettings),
      /active turn/,
    );
    assert.equal(calls, 1);
    assert.equal((await hub.snapshot(ref))?.session.compacting, true);
    assert.equal(hub.listSessions()[0]?.compacting, true);
    const otherSnapshot = await hub.subscribe(recordingSocket(), ref);
    assert.equal(otherSnapshot?.session.compacting, true);
    assert.deepEqual(f.repository.get(ref.sessionId), beforeCompact);
    notify("child", { type: "compaction.finished" });
    assert.equal(hub.listSessions()[0]?.compacting, true);
    notify("native", { type: "compaction.finished" });
    assert.equal(hub.listSessions()[0]?.compacting, false);
    assert.deepEqual(
      sent
        .filter((message) => message.type === "session.upserted")
        .map((message) => message.session.compacting),
      [true, false],
    );
    assert.equal((await hub.snapshot(ref))?.session.state, "idle");
    assert.equal(hub.interrupt(ref), false);
    notify("native", {
      type: "context.usage",
      usage: { usedTokens: 12000, maxTokens: 272000 },
    });
    notify("child", {
      type: "context.usage",
      usage: { usedTokens: 999, maxTokens: 1000 },
    });
    assert.deepEqual((await hub.snapshot(ref))?.session.contextUsage, {
      usedTokens: 12000,
      maxTokens: 272000,
    });
    assert.deepEqual(hub.listSessions()[0]?.contextUsage, {
      usedTokens: 12000,
      maxTokens: 272000,
    });
    const freshHub = new SessionHub([f.driver], f.repository);
    assert.equal((await freshHub.snapshot(ref))?.session.contextUsage, null);
    const beforeFailure = f.repository.get(ref.sessionId);
    f.driver.compact = async () => {
      throw new Error("cannot compact");
    };
    await assert.rejects(hub.compact(ref), /cannot compact/);
    assert.deepEqual(f.repository.get(ref.sessionId), beforeFailure);
    assert.equal(hub.listSessions()[0]?.compacting, false);
  } finally {
    await hub.close();
  }
});

test("metadata.changed updates the session title and broadcasts upsert", async () => {
  const f = await modelTestHub();
  let notify!: Parameters<AgentDriver["onSessionUpdate"]>[0];
  f.driver.onSessionUpdate = (listener) => {
    notify = listener;
  };
  const hub = new SessionHub([f.driver], f.repository);
  try {
    const sent: ServerMessage[] = [];
    const socket = recordingSocket(sent);
    hub.registerClient(socket);
    const ref = await hub.importSession({
      provider: "codex",
      providerSessionId: "native-title",
      projectId: f.projectId,
    });
    sent.length = 0;
    const updatedAt = new Date("2030-01-01T00:00:00Z").toISOString();
    notify("native-title", {
      type: "metadata.changed",
      metadata: { title: "Fresh title", updatedAt },
    });
    const upserts = sent.filter(
      (
        message,
      ): message is Extract<ServerMessage, { type: "session.upserted" }> =>
        message.type === "session.upserted",
    );
    assert.equal(upserts.length, 1);
    assert.equal(upserts[0].session.title, "Fresh title");
    assert.equal((await hub.snapshot(ref))?.session.title, "Fresh title");

    // An identical title must not re-broadcast.
    sent.length = 0;
    notify("native-title", {
      type: "metadata.changed",
      metadata: { title: "Fresh title", updatedAt },
    });
    assert.equal(
      sent.some((message) => message.type === "session.upserted"),
      false,
    );
  } finally {
    await hub.close();
  }
});

test("deleteNativeSession removes the provider file and the managed record atomically", async () => {
  const cwd = await fixtureCwd();
  const repository = memoryRepository();
  const projectId = fixtureProjectId(repository, cwd);
  const sent: ServerMessage[] = [];
  const socket = recordingSocket(sent);
  const deletedHandles: Array<Parameters<AgentDriver["deleteSession"]>[0]> = [];
  const driver: AgentDriver = {
    provider: "codex",
    ready: true,
    async listSessions() {
      return { sessions: [], nextCursor: null };
    },
    async listModels() {
      return fixtureModelCatalog();
    },
    onSessionUpdate() {},
    async start() {},
    async close() {},
    async readSession() {
      return {
        metadata: { updatedAt: "2026-09-03T00:00:00.000Z" },
        events: [],
      };
    },
    async deleteSession(handle) {
      deletedHandles.push(handle);
    },
    async createSession() {
      throw new Error("not used");
    },
    async runTurn() {},
  };
  const hub = new SessionHub([driver], repository);
  try {
    const imported = await hub.importSession({
      provider: "codex",
      providerSessionId: "native-delete-me",
      projectId,
    });
    hub.registerClient(socket);
    const result = await hub.deleteNativeSession({
      provider: "codex",
      providerSessionId: "native-delete-me",
      projectId,
    });
    assert.deepEqual(result, {
      removedManagedSessionId: imported.sessionId,
    });
    assert.deepEqual(deletedHandles, [
      { providerSessionId: "native-delete-me", cwd },
    ]);
    assert.equal(repository.get(imported.sessionId), undefined);
    assert.equal(hub.listSessions().length, 0);
    assert.ok(
      sent.some(
        (message) =>
          message.type === "session.removed" &&
          message.sessionId === imported.sessionId,
      ),
    );

    // An unmanaged native session still deletes the provider file.
    const unmanaged = await hub.deleteNativeSession({
      provider: "codex",
      providerSessionId: "native-standalone",
      projectId,
    });
    assert.deepEqual(unmanaged, { removedManagedSessionId: null });
    assert.deepEqual(deletedHandles[1], {
      providerSessionId: "native-standalone",
      cwd,
    });
  } finally {
    await hub.close();
  }
});

test("deleteNativeSession rejects foreign management, busy sessions and stale projects", async () => {
  const cwd = await fixtureCwd();
  const repository = memoryRepository();
  const projectId = fixtureProjectId(repository, cwd);
  const driver: AgentDriver = {
    provider: "codex",
    ready: true,
    async listSessions() {
      return { sessions: [], nextCursor: null };
    },
    async listModels() {
      return fixtureModelCatalog();
    },
    onSessionUpdate() {},
    async start() {},
    async close() {},
    async readSession() {
      return {
        metadata: { updatedAt: "2026-09-03T00:00:00.000Z" },
        events: [],
      };
    },
    async deleteSession() {
      throw new Error("provider delete must not run");
    },
    async createSession() {
      throw new Error("not used");
    },
    async runTurn({ signal, context }) {
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      context.setState("interrupted");
    },
  };
  const hub = new SessionHub([driver], repository);
  try {
    const imported = await hub.importSession({
      provider: "codex",
      providerSessionId: "native-busy",
      projectId,
    });
    await hub.startTurn(imported, "task", "turn-1", fixtureModelSettings);
    await assert.rejects(
      hub.deleteNativeSession({
        provider: "codex",
        providerSessionId: "native-busy",
        projectId,
      }),
      /busy/,
    );
    hub.interrupt(imported);
    await new Promise<void>((resolve) => setImmediate(resolve));

    await assert.rejects(
      hub.deleteNativeSession({
        provider: "codex",
        providerSessionId: "native-busy",
        projectId: "missing-project",
      }),
      /Project not found/,
    );

    // The same native session managed by another project in the same state.
    const otherProjectId = repository.importProject({
      name: "fixture-other",
      path: await realpath(join(cwd, "src")),
    }).projectId;
    await assert.rejects(
      hub.deleteNativeSession({
        provider: "codex",
        providerSessionId: "native-busy",
        projectId: otherProjectId,
      }),
      /different project/,
    );
    assert.notEqual(repository.get(imported.sessionId), undefined);
  } finally {
    await hub.close();
  }
});

function operationGate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("native deletion blocks starts across model discovery and compaction, and releases on failure", async () => {
  const f = await modelTestHub();
  const modelEntered = operationGate();
  const modelRelease = operationGate();
  const deleteEntered = operationGate();
  const deleteRelease = operationGate();
  const input = {
    provider: "codex" as const,
    providerSessionId: "native-race",
    projectId: f.projectId,
  };
  try {
    const ref = await f.hub.importSession(input);
    f.driver.listModels = async () => {
      modelEntered.resolve();
      await modelRelease.promise;
      return fixtureModelCatalog();
    };
    f.driver.deleteSession = async () => {
      deleteEntered.resolve();
      await deleteRelease.promise;
      throw new Error("provider delete failed");
    };
    f.driver.compact = async () => {
      assert.fail("compaction must not start during deletion");
    };
    const starting = assert.rejects(
      f.hub.startTurn(ref, "task", "racing-start", fixtureModelSettings),
      /busy/,
    );
    await modelEntered.promise;
    const deleting = assert.rejects(
      f.hub.deleteNativeSession(input),
      /provider delete failed/,
    );
    await deleteEntered.promise;
    modelRelease.resolve();
    await starting;
    await assert.rejects(
      f.hub.startTurn(ref, "task", "later-start", fixtureModelSettings),
      /busy/,
    );
    await assert.rejects(f.hub.compact(ref), /busy/);
    assert.equal(f.received.length, 0);
    // Other native sessions remain usable while this one's deletion is pending.
    const other = await f.hub.importSession({
      ...input,
      providerSessionId: "unrelated-native",
    });
    assert.notEqual(other.sessionId, ref.sessionId);
    const importing = f.hub.importSession(input);
    deleteRelease.resolve();
    await deleting;
    assert.equal((await importing).sessionId, ref.sessionId);
    assert.equal(
      await f.hub.startTurn(
        ref,
        "retry",
        "after-failure",
        fixtureModelSettings,
      ),
      true,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.received.length, 1);
    await assert.rejects(f.hub.deleteNativeSession(input), /busy/);
    f.hub.interrupt(ref);
    await new Promise<void>((resolve) => setImmediate(resolve));
    f.driver.compact = async () => {};
    await f.hub.compact(ref);
    await assert.rejects(f.hub.deleteNativeSession(input), /busy/);
  } finally {
    modelRelease.resolve();
    deleteRelease.resolve();
    await f.hub.close();
  }
});

for (const first of ["import", "delete"] as const) {
  test(`native ${first} serializes against the other operation without leaving a stale registration`, async () => {
    const f = await modelTestHub();
    const entered = operationGate();
    const release = operationGate();
    const input = {
      provider: "codex" as const,
      providerSessionId: "native-unmanaged",
      projectId: f.projectId,
    };
    let exists = true;
    let reads = 0;
    let deletes = 0;
    f.driver.readSession = async () => {
      reads++;
      if (first === "import") {
        entered.resolve();
        await release.promise;
      }
      if (!exists) throw new Error("native not found");
      return { metadata: { updatedAt: new Date().toISOString() }, events: [] };
    };
    f.driver.deleteSession = async () => {
      deletes++;
      if (first === "delete") {
        entered.resolve();
        await release.promise;
      }
      exists = false;
    };
    try {
      if (first === "import") {
        const importing = f.hub.importSession(input);
        await entered.promise;
        const deleting = f.hub.deleteNativeSession(input);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(deletes, 0);
        release.resolve();
        const session = await importing;
        assert.equal(
          (await deleting).removedManagedSessionId,
          session.sessionId,
        );
      } else {
        const deleting = f.hub.deleteNativeSession(input);
        await entered.promise;
        const importing = assert.rejects(
          f.hub.importSession(input),
          /native not found/,
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(reads, 0);
        release.resolve();
        await deleting;
        await importing;
      }
      assert.equal(f.repository.list().length, 0);
      assert.equal(exists, false);
      // A later provider-side recreation can be imported: the reservation is gone.
      exists = true;
      const recreated = await f.hub.importSession(input);
      assert.equal(
        f.repository.get(recreated.sessionId)?.providerSessionId,
        input.providerSessionId,
      );
    } finally {
      release.resolve();
      await f.hub.close();
    }
  });
}

test("reports creation errors immediately and returns a generic error on retry", async () => {
  const f = await modelTestHub();
  f.driver.createSession = async () => {
    throw new Error("native allocation failed");
  };
  const create = () =>
    f.hub.createSession(
      f.socket,
      "codex",
      f.projectId,
      "failed-create",
      "hello",
      fixtureModelSettings,
    );
  try {
    await assert.rejects(create(), /native allocation failed/);
    assert.equal(f.repository.list()[0]?.lifecycle, "failed");
    await assert.rejects(create(), /^Error: Session creation failed$/);
  } finally {
    await f.hub.close();
  }
});

test("broadcasts execution errors immediately while retaining the execution state", async () => {
  const f = await modelTestHub();
  const messages: ServerMessage[] = [];
  f.driver.runTurn = async () => {
    throw new Error("native turn failed");
  };
  try {
    const { ref } = await f.hub.createSession(
      recordingSocket(messages),
      "codex",
      f.projectId,
      "failed-turn",
      "hello",
      fixtureModelSettings,
    );
    await f.hub.startTurn(
      ref,
      "hello",
      "create:failed-turn",
      fixtureModelSettings,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert(
      messages.some(
        (message) =>
          message.type === "timeline.event" &&
          message.event.type === "system.notice" &&
          message.event.level === "error" &&
          message.event.text === "native turn failed",
      ),
    );
    assert.equal(f.repository.get(ref.sessionId)?.state, "error");
  } finally {
    await f.hub.close();
  }
});
