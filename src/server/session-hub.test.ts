import sharp from "sharp";
import { ImageInputs } from "./images/input.js";
import type { UserInput } from "../shared/user-input.js";
import {
  fixtureModelCatalog,
  fixtureModelSettings,
} from "../../test/model-catalog.js";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { memoryRepository } from "../../test/state.js";
import { WebSocket } from "ws";
import type { ServerMessage, TimelineEvent } from "../shared/protocol.js";
import { buildTimeline } from "../web/store.js";
import type { AgentDriver, SessionSnapshot } from "./drivers/driver.js";
import { ProviderSessionNotFoundError } from "./drivers/driver.js";
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

async function fixtureDirectory(t: test.TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "racco-hub-project-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return realpath(path);
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
  const hub = new SessionHub([driver], repository, cwd, async () => {});
  return {
    hub,
    driver,
    repository,
    projectId,
    cwd,
    received,
    allocations: () => allocations,
    setReady: (value: boolean) => {
      ready = value;
    },
    socket: recordingSocket(),
  };
}

async function imageContent(): Promise<UserInput> {
  const data = await sharp({
    create: { width: 8, height: 8, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  return [
    { type: "image", mediaType: "image/png", data: data.toString("base64") },
  ];
}

function trackInputLeases(t: test.TestContext) {
  const leases: Array<{ content: UserInput; releases: number }> = [];
  const prepare = ImageInputs.prototype.prepare;
  t.mock.method(
    ImageInputs.prototype,
    "prepare",
    async function (this: ImageInputs, content: UserInput) {
      const lease = await prepare.call(this, content);
      const record = { content: lease.content, releases: 0 };
      leases.push(record);
      return {
        content: lease.content,
        release() {
          record.releases++;
          lease.release();
        },
      };
    },
  );
  return leases;
}

test("rejects invalid model/effort pairs before allocating a native session", async () => {
  const f = await modelTestHub();
  try {
    await assert.rejects(
      f.hub.createSession(
        f.socket,
        "codex",
        f.projectId,
        f.cwd,
        "bad",
        [{ type: "text", text: "task" }],
        {
          modelId: "fixture-fast",
          reasoningEffort: "xhigh",
        },
      ),
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
      f.cwd,
      "stream-lifecycle",
      [{ type: "text", text: "hello" }],
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

test("active-session reconnect snapshots retain only the current streaming content", async () => {
  const f = await modelTestHub();
  let emit!: (event: TimelineEvent) => void;
  f.driver.runTurn = async ({ context, signal }) => {
    emit = context.emit;
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
  };
  try {
    const { ref } = await f.hub.createSession(
      { readyState: WebSocket.CLOSED } as WebSocket,
      "codex",
      f.projectId,
      f.cwd,
      "compact-stream",
      [{ type: "text", text: "hello" }],
      fixtureModelSettings,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (let count = 1; count <= 2000; count++) {
      emit({
        type: "assistant.message",
        id: "answer",
        text: "x".repeat(count * 20),
        partial: true,
      });
    }
    const snapshot = await f.hub.snapshot(ref);
    assert(snapshot);
    assert.equal(snapshot.events.length, 2);
    assert.equal(snapshot.events.at(-1)?.type, "assistant.message");
    assert(JSON.stringify(snapshot).length < 41_000);
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
        f.cwd,
        "same",
        [{ type: "text", text: "task" }],
        fixtureModelSettings,
      );
    const [first, second] = await Promise.all([create(), create()]);
    assert.deepEqual(first.ref, second.ref);
    assert.equal(f.allocations(), 1);
    assert.equal(f.repository.get(first.ref.sessionId)?.lifecycle, "active");
    const starts = await Promise.all([
      f.hub.startTurn(
        first.ref,
        [{ type: "text", text: "task" }],
        "create:same",
        fixtureModelSettings,
      ),
      f.hub.startTurn(
        first.ref,
        [{ type: "text", text: "task" }],
        "create:same",
        fixtureModelSettings,
      ),
    ]);
    assert.deepEqual(starts, [false, false]);
    assert.deepEqual(f.received, [fixtureModelSettings]);
    assert.deepEqual(
      f.repository.get(first.ref.sessionId)?.selectedModelSettings,
      fixtureModelSettings,
    );
    await assert.rejects(
      f.hub.startTurn(
        first.ref,
        [{ type: "text", text: "task" }],
        "create:same",
        {
          ...fixtureModelSettings,
          reasoningEffort: "xhigh",
        },
      ),
      /Initial turn does not match/,
    );
    await assert.rejects(
      f.hub.createSession(
        f.socket,
        "codex",
        f.projectId,
        f.cwd,
        "same",
        [{ type: "text", text: "changed task" }],
        fixtureModelSettings,
      ),
      /different parameters/,
    );
    f.setReady(false);
    assert.equal(
      await f.hub.startTurn(
        first.ref,
        [{ type: "text", text: "task" }],
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

test("a provisioning session with a native ID can complete after recovery without allocation", async (t) => {
  const f = await modelTestHub();
  try {
    const accept = t.mock.method(f.repository, "acceptTurn", () => {
      throw new Error("stopped before acceptance");
    });
    await assert.rejects(
      f.hub.createSession(
        f.socket,
        "codex",
        f.projectId,
        f.cwd,
        "recover",
        [{ type: "text", text: "task" }],
        fixtureModelSettings,
      ),
      /stopped before acceptance/,
    );
    accept.mock.restore();
    const allocated = f.repository.findByCreateRequestId("recover")!;
    assert.equal(f.received.length, 0);
    await f.hub.initialize();
    assert.equal(
      f.repository.get(allocated.sessionId)?.lifecycle,
      "provisioning",
    );
    const replay = await f.hub.createSession(
      f.socket,
      "codex",
      f.projectId,
      f.cwd,
      "recover",
      [{ type: "text", text: "task" }],
      fixtureModelSettings,
    );
    assert.equal(replay.ref.sessionId, allocated.sessionId);
    assert.equal(f.allocations(), 1);
    assert.equal(f.received.length, 1);
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
      path: f.cwd,
      providerSessionId: "imported",
    });
    const alternate = { modelId: "fixture-fast", reasoningEffort: "medium" };
    const results = await Promise.allSettled([
      f.hub.startTurn(
        session,
        [{ type: "text", text: "a" }],
        "client-a",
        fixtureModelSettings,
      ),
      f.hub.startTurn(
        session,
        [{ type: "text", text: "b" }],
        "client-b",
        alternate,
      ),
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
    await f.hub.startTurn(
      session,
      [{ type: "text", text: "next" }],
      "next",
      alternate,
    );
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
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
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
      await pending;
    },
  };
  const hub = new SessionHub([driver], repository, cwd, async () => {});
  hub.registerClient(socket);
  const created = await hub.createSession(
    socket,
    "claude",
    fixtureProjectId(repository, cwd),
    cwd,
    "create-1",
    [{ type: "text", text: "first" }],
    fixtureModelSettings,
  );

  assert.equal(
    sent.some(
      (message) =>
        message.type === "session.upserted" &&
        message.session.lifecycle === "active" &&
        message.session.state === "idle",
    ),
    false,
  );

  finish();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await assert.doesNotReject(
    async () =>
      await hub.startTurn(
        created.ref,
        [{ type: "text", text: "second" }],
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
        imageCount: 0,
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
  const hub = new SessionHub([driver], repository, cwd, async () => {});
  await hub.createSession(
    socket,
    "codex",
    fixtureProjectId(repository, cwd),
    cwd,
    "create-immediate-user",
    [{ type: "text", text: "hello" }],
    fixtureModelSettings,
  );

  const immediateEvents = sent.filter(
    (message) => message.type === "timeline.event",
  );
  assert.deepEqual(
    immediateEvents.map((message) => message.event),
    [
      {
        imageCount: 0,
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
  const hub = new SessionHub([driver], repository, cwd, async () => {});
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
    [{ type: "text", text: "race" }],
    "race-turn",
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
  assert.equal(snapshot.events.length, 3);
  assert(snapshot.events[0]?.type === "user.message");
  assert.equal(snapshot.events[0].text, "race");
  assert.deepEqual(snapshot.events[1], {
    type: "assistant.message",
    id: "live",
    text: "live",
  });
  const notice = snapshot.events[2];
  assert(notice.type === "system.notice");
  assert.equal(notice.level, "warning");
  assert.match(notice.text, /本次未更新完整历史，请重试/);
  assert.equal(
    snapshot.events.some((event) => event.id === "stale"),
    false,
  );

  finishTurn();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await hub.close();
});

for (const readOutcome of ["success", "missing", "error"] as const) {
  test(`deleting a session discards its pending ${readOutcome} history read`, async () => {
    const f = await modelTestHub();
    let resolveRead!: (snapshot: SessionSnapshot) => void;
    let rejectRead!: (error: Error) => void;
    const read = new Promise<SessionSnapshot>((resolve, reject) => {
      resolveRead = resolve;
      rejectRead = reject;
    });
    let reads = 0;
    f.driver.readSession = async () => {
      reads += 1;
      return read;
    };
    const managed = f.repository.importSession({
      provider: "codex",
      providerSessionId: "deletion-race",
      projectId: f.projectId,
      cwd: f.cwd,
      updatedAt: "2026-09-03T00:00:00.000Z",
    });
    try {
      const pending = f.hub.subscribe(recordingSocket(), managed);
      assert.equal(reads, 1);
      assert(f.hub.deleteSession(managed.sessionId));
      if (readOutcome === "success") {
        resolveRead({
          metadata: {
            title: "Obsolete",
            updatedAt: "2026-09-04T00:00:00.000Z",
          },
          events: [
            { type: "assistant.message", id: "obsolete", text: "old history" },
          ],
        });
      } else {
        rejectRead(
          readOutcome === "missing"
            ? new ProviderSessionNotFoundError("Provider session deleted")
            : new Error("Provider read failed"),
        );
      }
      assert.equal(await pending, undefined);
      assert.deepEqual(f.hub.listSessions(), []);
      assert.equal(f.repository.get(managed.sessionId), undefined);
    } finally {
      await f.hub.close();
    }
  });
}

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
  const hub = new SessionHub([driver], repository, cwd, async () => {});
  const created = await hub.createSession(
    socket,
    "claude",
    fixtureProjectId(repository, cwd),
    cwd,
    "create-pending",
    [{ type: "text", text: "initial" }],
    fixtureModelSettings,
  );

  const snapshot = await hub.snapshot(created.ref);
  assert.equal(snapshot?.type, "session.snapshot");
  assert.equal(reads, 0);
  assert.notEqual(created.ref.sessionId, "native-pending");
  await hub.close();
});

test("rejects unregistered Racco IDs before calling a provider", async () => {
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
  const hub = new SessionHub([driver], repository, cwd, async () => {});

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
  const hub = new SessionHub([driver], repository, cwd, async () => {});
  const created = await hub.createSession(
    recordingSocket(),
    "claude",
    fixtureProjectId(repository, cwd),
    cwd,
    "create-recovered",
    [{ type: "text", text: "initial" }],
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
  const hub = new SessionHub([driver], repository, cwd, async () => {});
  const created = await hub.createSession(
    recordingSocket(),
    "claude",
    fixtureProjectId(repository, cwd),
    cwd,
    "create-idempotent",
    [{ type: "text", text: "hello" }],
    fixtureModelSettings,
  );

  assert.equal(
    await hub.startTurn(
      created.ref,
      [{ type: "text", text: "hello" }],
      "create:create-idempotent",
      fixtureModelSettings,
    ),
    false,
  );
  assert.equal(
    await hub.startTurn(
      created.ref,
      [{ type: "text", text: "hello" }],
      "create:create-idempotent",
      fixtureModelSettings,
    ),
    false,
  );
  await assert.rejects(
    async () =>
      await hub.startTurn(
        created.ref,
        [{ type: "text", text: "different" }],
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
        events: [
          { imageCount: 0, type: "user.message", id: "user-1", text: "hello" },
        ],
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
  const hub = new SessionHub([driver], repository, cwd, async () => {});
  const projectId = fixtureProjectId(repository, cwd);

  const first = await hub.importSession({
    provider: "codex",
    providerSessionId: "native-import",
    projectId,
    path: cwd,
  });
  const second = await hub.importSession({
    provider: "codex",
    providerSessionId: "native-import",
    projectId,
    path: cwd,
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
  const hub = new SessionHub([driver], repository, cwd, async () => {});
  const created = await hub.createSession(
    recordingSocket(),
    "codex",
    fixtureProjectId(repository, cwd),
    cwd,
    "create-shutdown",
    [{ type: "text", text: "wait" }],
    fixtureModelSettings,
  );

  await hub.close();

  assert.equal(repository.get(created.ref.sessionId)?.state, "interrupted");
  database.close();
});

test("imports canonical projects into the database without scanning a parent", async (t) => {
  const cwd = await fixtureDirectory(t);
  const repository = memoryRepository();
  const hub = new SessionHub(
    [],
    repository,
    await fixtureCwd(),
    async () => {},
  );

  const first = await hub.importProject(cwd);
  const second = await hub.importProject(cwd);

  assert.equal(first.projectId, second.projectId);
  assert.equal(first.path, cwd);
  assert.deepEqual(hub.listProjects(), [first]);
  await hub.close();
});

test("serializes concurrent repository ownership checks before project registration", async (t) => {
  const childProcess = (await import("node:child_process")).default;
  const filesystem = (await import("node:fs/promises")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const { runGit } = await import("./worktrees/git.js");
  const { assertProjectRoot } = await import("./worktrees/derive.js");
  const fixture = await fixtureDirectory(t);
  const main = join(fixture, "one");
  const second = join(fixture, "two");
  const admin = join(fixture, "admin");
  const existing = join(fixture, "existing");
  await runGit(["init", "-q", `--separate-git-dir=${admin}`, main]);
  await mkdir(second);
  await writeFile(join(second, ".git"), `gitdir: ${admin}\n`);
  await runGit(["init", "-q", existing]);
  // Both are valid main roots, yet Git reports the same administrative identity.
  await assertProjectRoot(main);
  await assertProjectRoot(second);
  const gitReplies = new Map<string, string>();
  for (const cwd of [main, second, existing]) {
    for (const command of [
      ["worktree", "list", "--porcelain"],
      [
        "rev-parse",
        "--path-format=absolute",
        "--show-toplevel",
        "--git-dir",
        "--git-common-dir",
      ],
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    ]) {
      gitReplies.set(
        JSON.stringify([cwd, command]),
        await runGit(command, { cwd }),
      );
    }
  }
  const canonicalPaths = new Map(
    await Promise.all(
      [main, second, admin, existing].map(
        async (path) => [path, await realpath(path)] as const,
      ),
    ),
  );
  const repository = memoryRepository();
  repository.importProject({ name: "existing", path: existing });
  const hub = new SessionHub([], repository, fixture, async () => {});

  // Gate Git callbacks after canonicalization. Both contenders in the broken
  // implementation observe the same project list before either can insert.
  let markCanonicalized!: () => void;
  const canonicalized = new Promise<void>((resolve) => {
    markCanonicalized = resolve;
  });
  const remaining = new Set([main, second]);
  const stat = filesystem.stat;
  const statMock = t.mock.method(
    filesystem,
    "stat",
    async (...args: Parameters<typeof stat>) => {
      const result = await stat(...args);
      remaining.delete(String(args[0]));
      if (remaining.size === 0) markCanonicalized();
      return result;
    },
  );
  const readRealpath = filesystem.realpath;
  const realpathMock = t.mock.method(
    filesystem,
    "realpath",
    async (...args: Parameters<typeof readRealpath>) =>
      canonicalPaths.get(String(args[0])) ?? readRealpath(...args),
  );
  const replies: Array<() => void> = [];
  const gitMock = t.mock.method(
    childProcess,
    "execFile",
    (...args: unknown[]) => {
      const [file, command, options, callback] = args as [
        string,
        string[],
        { cwd: string },
        (error: null, stdout: string, stderr: string) => void,
      ];
      assert.equal(file, "git");
      const stdout = gitReplies.get(JSON.stringify([options.cwd, command]));
      assert.notEqual(stdout, undefined, "unexpected Git query");
      replies.push(() => callback(null, stdout!, ""));
      return new childProcess.ChildProcess();
    },
  );
  syncBuiltinESMExports();
  async function complete<T>(operation: Promise<T>): Promise<T> {
    let finished = false;
    void operation.then(
      () => {
        finished = true;
      },
      () => {
        finished = true;
      },
    );
    while (!finished) {
      for (const reply of replies.splice(0)) reply();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return operation;
  }
  try {
    const importing = Promise.allSettled([
      hub.importProject(main),
      hub.importProject(second),
    ]);
    await canonicalized;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const results = await complete(importing);
    const accepted = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    assert.equal(accepted.length, 1);
    assert.equal(rejected.length, 1);
    assert.match(String(rejected[0].reason), /已注册为项目/);
    assert.equal(repository.listProjects().length, 2);
    // A rejected registration cannot poison subsequent imports.
    const repeated = await complete(hub.importProject(accepted[0].value.path));
    assert.equal(repeated.projectId, accepted[0].value.projectId);
  } finally {
    statMock.mock.restore();
    realpathMock.mock.restore();
    gitMock.mock.restore();
    syncBuiltinESMExports();
    await hub.close();
  }
});

test("concurrent aliases of a valid main worktree return one project", async (t) => {
  const { runGit } = await import("./worktrees/git.js");
  const fixture = await fixtureDirectory(t);
  const main = join(fixture, "repo");
  const alias = join(fixture, "alias");
  await runGit(["init", "-q", main]);
  await symlink(main, alias);
  const repository = memoryRepository();
  const hub = new SessionHub([], repository, fixture, async () => {});
  try {
    const projects = await Promise.all([
      hub.importProject(main),
      hub.importProject(alias),
    ]);
    assert.equal(projects[0].projectId, projects[1].projectId);
    assert.equal(projects[0].path, main);
    assert.equal(repository.listProjects().length, 1);
  } finally {
    await hub.close();
  }
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
  const hub = new SessionHub([driver], repository, cwd, async () => {});

  await assert.rejects(
    hub.createSession(
      recordingSocket(),
      "codex",
      "unknown-project",
      cwd,
      "create-unknown",
      [{ type: "text", text: "initial" }],
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
      context.emit({
        imageCount: 0,
        type: "user.message",
        id: "user-shared",
        text: "hello",
      });
      context.emit({
        type: "assistant.message",
        id: "agent-shared",
        text: "done",
      });
      context.setState("idle");
    },
  };
  const hub = new SessionHub([driver], repository, cwd, async () => {});
  const created = await hub.createSession(
    socketA,
    "codex",
    fixtureProjectId(repository, cwd),
    cwd,
    "create-shared",
    [{ type: "text", text: "hello" }],
    fixtureModelSettings,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  await hub.subscribe(socketB, created.ref);
  sentA.length = 0;
  sentB.length = 0;
  await hub.startTurn(
    created.ref,
    [{ type: "text", text: "hello" }],
    "next-broadcast",
    fixtureModelSettings,
  );

  await new Promise<void>((resolve) => setImmediate(resolve));

  for (const sent of [sentA, sentB]) {
    const events = sent.filter((message) => message.type === "timeline.event");
    assert.equal(events.length, 2);
  }
  await hub.close();
});

for (const outcome of ["interrupt", "completed", "error", "answer"] as const) {
  test(`closes pending questions for every subscriber when a turn is ${outcome}`, async () => {
    const f = await modelTestHub();
    const sentA: ServerMessage[] = [];
    const sentB: ServerMessage[] = [];
    let finishTurn!: () => void;
    let settled!: Promise<PromiseSettledResult<unknown>[]>;
    f.driver.runTurn = async ({ context, signal }) => {
      settled = Promise.allSettled(
        ["first", "second"].map((id) =>
          context.requestInteraction({
            title: id,
            questions: [{ id, text: id, multiple: false }],
          }),
        ),
      );
      await new Promise<void>((resolve) => {
        finishTurn = resolve;
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      if (outcome === "error") throw new Error("Provider failed");
    };
    try {
      const { ref } = await f.hub.createSession(
        recordingSocket(sentA),
        "codex",
        f.projectId,
        f.cwd,
        `questions-${outcome}`,
        [{ type: "text", text: "Ask" }],
        fixtureModelSettings,
      );
      const joined = await f.hub.subscribe(recordingSocket(sentB), ref);
      assert(joined);
      assert.equal(joined.pendingInteractions.length, 2);
      const ids = joined.pendingInteractions.map((question) => question.id);
      if (outcome === "answer") {
        assert(
          f.hub.resolveInteraction(ids[0], {
            decision: "answer",
            answers: { first: ["yes"] },
          }),
        );
        assert.equal(f.hub.listSessions()[0].state, "waiting_interaction");
        assert(f.hub.resolveInteraction(ids[1], { decision: "deny" }));
        assert.equal(f.hub.listSessions()[0].state, "running");
      }
      if (outcome === "interrupt") assert(f.hub.interrupt(ref));
      else finishTurn();
      await new Promise<void>((resolve) => setImmediate(resolve));
      const results = await settled;
      assert(
        results.every(
          (result) =>
            result.status === (outcome === "answer" ? "fulfilled" : "rejected"),
        ),
      );
      for (const sent of [sentA, sentB]) {
        assert.deepEqual(
          sent.flatMap((message) =>
            message.type === "interaction.resolved"
              ? [message.interactionId]
              : [],
          ),
          ids,
        );
      }
      assert.deepEqual((await f.hub.snapshot(ref))?.pendingInteractions, []);
      assert.equal(
        f.hub.resolveInteraction(ids[0], { decision: "deny" }),
        false,
      );
    } finally {
      await f.hub.close();
    }
  });
}

test("broadcasts project and session catalog updates to every connected client", async (t) => {
  const cwd = await fixtureDirectory(t);
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
  const hub = new SessionHub([driver], repository, cwd, async () => {});
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
    project.path,
    "create-catalog",
    [{ type: "text", text: "hello" }],
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
        .filter((message) => message.session.lifecycle === "active")
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
  const hub = new SessionHub([f.driver], f.repository, f.cwd, async () => {});
  let calls = 0;
  f.driver.compact = async () => {
    calls++;
  };
  try {
    const ref = await hub.importSession({
      provider: "codex",
      providerSessionId: "native",
      projectId: f.projectId,
      path: f.cwd,
    });
    const sent: ServerMessage[] = [];
    const socket = recordingSocket(sent);
    hub.registerClient(socket);
    await hub.subscribe(socket, ref);
    const beforeCompact = f.repository.get(ref.sessionId);
    await hub.compact(ref);
    await assert.rejects(hub.compact(ref), /busy/);
    await assert.rejects(
      hub.startTurn(
        ref,
        [{ type: "text", text: "blocked" }],
        "while-compacting",
        fixtureModelSettings,
      ),
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
    const freshHub = new SessionHub(
      [f.driver],
      f.repository,
      f.cwd,
      async () => {},
    );
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
  const hub = new SessionHub([f.driver], f.repository, f.cwd, async () => {});
  try {
    const sent: ServerMessage[] = [];
    const socket = recordingSocket(sent);
    hub.registerClient(socket);
    const ref = await hub.importSession({
      provider: "codex",
      providerSessionId: "native-title",
      projectId: f.projectId,
      path: f.cwd,
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
  const hub = new SessionHub([driver], repository, cwd, async () => {});
  try {
    const imported = await hub.importSession({
      provider: "codex",
      providerSessionId: "native-delete-me",
      projectId,
      path: cwd,
    });
    hub.registerClient(socket);
    const result = await hub.deleteNativeSession({
      provider: "codex",
      providerSessionId: "native-delete-me",
      projectId,
      path: cwd,
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
      path: cwd,
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
  const hub = new SessionHub([driver], repository, cwd, async () => {});
  try {
    const imported = await hub.importSession({
      provider: "codex",
      providerSessionId: "native-busy",
      projectId,
      path: cwd,
    });
    await hub.startTurn(
      imported,
      [{ type: "text", text: "task" }],
      "turn-1",
      fixtureModelSettings,
    );
    await assert.rejects(
      hub.deleteNativeSession({
        provider: "codex",
        providerSessionId: "native-busy",
        projectId,
        path: cwd,
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
        path: cwd,
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
        path: await realpath(join(cwd, "src")),
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

test("a late subscription cannot replace a newer session or reattach a disconnected socket", async () => {
  const f = await modelTestHub();
  const entered = operationGate();
  const release = operationGate();
  const sent: ServerMessage[] = [];
  const socket = recordingSocket(sent);
  const input = {
    provider: "codex" as const,
    projectId: f.projectId,
    path: f.cwd,
  };
  try {
    const slow = await f.hub.importSession({
      ...input,
      providerSessionId: "slow",
    });
    const fast = await f.hub.importSession({
      ...input,
      providerSessionId: "fast",
    });
    f.driver.readSession = async (handle) => {
      if (handle.providerSessionId === "slow") {
        entered.resolve();
        await release.promise;
      }
      return { metadata: { updatedAt: new Date().toISOString() }, events: [] };
    };
    const pending = f.hub.subscribe(socket, slow);
    await entered.promise;
    await f.hub.subscribe(socket, fast);
    release.resolve();
    await pending;
    await f.hub.startTurn(
      fast,
      [{ type: "text", text: "fast" }],
      "fast-turn",
      fixtureModelSettings,
    );
    await f.hub.startTurn(
      slow,
      [{ type: "text", text: "slow" }],
      "slow-turn",
      fixtureModelSettings,
    );
    assert.deepEqual(
      sent
        .filter((message) => message.type === "timeline.event")
        .map((message) => message.session.sessionId),
      [fast.sessionId],
    );

    const pendingRead = operationGate();
    const finishRead = operationGate();
    f.driver.readSession = async () => {
      pendingRead.resolve();
      await finishRead.promise;
      return { metadata: { updatedAt: new Date().toISOString() }, events: [] };
    };
    const idle = f.repository.importSession({
      ...input,
      providerSessionId: "idle",
      cwd: f.cwd,
      title: "idle",
      updatedAt: new Date().toISOString(),
    });
    const disconnected = f.hub.subscribe(socket, idle);
    await pendingRead.promise;
    f.hub.unregisterClient(socket);
    finishRead.resolve();
    await disconnected;
    sent.length = 0;
    await f.hub.startTurn(
      idle,
      [{ type: "text", text: "idle" }],
      "idle-turn",
      fixtureModelSettings,
    );
    assert.equal(
      sent.filter((message) => message.type === "timeline.event").length,
      0,
    );
  } finally {
    release.resolve();
    await f.hub.close();
  }
});

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
    path: f.cwd,
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
      f.hub.startTurn(
        ref,
        [{ type: "text", text: "task" }],
        "racing-start",
        fixtureModelSettings,
      ),
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
      f.hub.startTurn(
        ref,
        [{ type: "text", text: "task" }],
        "later-start",
        fixtureModelSettings,
      ),
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
        [{ type: "text", text: "retry" }],
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
      path: f.cwd,
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
      f.cwd,
      "failed-create",
      [{ type: "text", text: "hello" }],
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
      f.cwd,
      "failed-turn",
      [{ type: "text", text: "hello" }],
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

test("deleteProject leaves linked worktrees on disk unless asked to remove them", async (t) => {
  const { mkdir, mkdtemp, rm, stat, writeFile } =
    await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { runGit } = await import("./worktrees/git.js");

  async function exists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }

  const fixture = await mkdtemp(join(tmpdir(), "racco-hub-delete-"));
  t.after(() => rm(fixture, { force: true, recursive: true }));
  const project = join(fixture, "repo");
  await mkdir(project);
  await runGit(["init", "-q", project]);
  await runGit(["config", "user.email", "fixture@example.com"], {
    cwd: project,
  });
  await runGit(["config", "user.name", "Fixture"], { cwd: project });
  await writeFile(join(project, "tracked.txt"), "fixture\n");
  await runGit(["add", "-A"], { cwd: project });
  await runGit(["commit", "-qm", "init"], { cwd: project });

  const worktreeRoot = join(fixture, "worktrees");
  await runGit(
    ["worktree", "add", "-b", "linked", join(worktreeRoot, "linked")],
    {
      cwd: project,
    },
  );

  const repository = memoryRepository();
  const projectId = repository.importProject({
    name: "fixture",
    path: project,
  }).projectId;
  const hub = new SessionHub([], repository, worktreeRoot, async () => {});
  t.after(() => hub.close());
  const linkedPath = join(worktreeRoot, "linked");
  assert.equal(await exists(linkedPath), true);

  // Default: linked worktrees stay on disk.
  await hub.deleteProject(projectId);
  assert.equal(repository.getProject(projectId), undefined);
  assert.equal(
    await exists(linkedPath),
    true,
    "linked worktree must survive default delete",
  );

  // Re-import the same directory: worktrees are re-derived from Git.
  const projectId2 = repository.importProject({
    name: "fixture",
    path: project,
  }).projectId;
  const before = await hub.listWorktrees(projectId2);
  assert.ok(before.worktrees.some((entry) => entry.path === linkedPath));

  // Explicit removeWorktrees: directories go away.
  await hub.deleteProject(projectId2, true);
  assert.equal(
    await exists(linkedPath),
    false,
    "linked worktree must be removed when asked",
  );
  assert.equal(
    await exists(project),
    true,
    "project directory itself is never removed",
  );
});

test("a matching initial image preparation failure marks provisioning failed without poisoning mismatched requests", async (t) => {
  const f = await modelTestHub();
  const sent: ServerMessage[] = [];
  const socket = recordingSocket(sent);
  f.hub.registerClient(socket);
  const content: UserInput = [
    {
      type: "image",
      mediaType: "image/png",
      data: (
        await sharp({
          create: { width: 8, height: 8, channels: 3, background: "red" },
        })
          .png()
          .toBuffer()
      ).toString("base64"),
    },
  ];
  try {
    const accept = t.mock.method(f.repository, "acceptTurn", () => {
      throw new Error("stopped before acceptance");
    });
    await assert.rejects(
      f.hub.createSession(
        socket,
        "codex",
        f.projectId,
        f.cwd,
        "image-prepare",
        content,
        fixtureModelSettings,
      ),
      /stopped before acceptance/,
    );
    accept.mock.restore();
    const created = {
      ref: {
        sessionId:
          f.repository.findByCreateRequestId("image-prepare")!.sessionId,
      },
    };
    let preparations = 0;
    t.mock.method(ImageInputs.prototype, "prepare", async () => {
      preparations++;
      throw new Error("图片处理容量已满");
    });
    await assert.rejects(
      f.hub.startTurn(
        created.ref,
        [{ type: "text", text: "changed" }],
        "create:image-prepare",
        fixtureModelSettings,
      ),
      /does not match/,
    );
    assert.equal(preparations, 0);
    assert.equal(
      f.repository.get(created.ref.sessionId)?.lifecycle,
      "provisioning",
    );
    await assert.rejects(
      f.hub.startTurn(
        created.ref,
        content,
        "create:image-prepare",
        fixtureModelSettings,
      ),
      /容量已满/,
    );
    assert.equal(f.repository.get(created.ref.sessionId)?.lifecycle, "failed");
    assert.equal(f.received.length, 0);
    assert(
      sent.some(
        (message) =>
          message.type === "session.upserted" &&
          message.session.sessionId === created.ref.sessionId &&
          message.session.lifecycle === "failed",
      ),
    );
    const existing = await f.hub.importSession({
      provider: "codex",
      providerSessionId: "existing-images",
      projectId: f.projectId,
      path: f.cwd,
    });
    await assert.rejects(
      f.hub.startTurn(
        existing,
        content,
        "ordinary-request",
        fixtureModelSettings,
      ),
      /容量已满/,
    );
    assert.equal(f.repository.get(existing.sessionId)?.lifecycle, "active");
  } finally {
    await f.hub.close();
  }
});

for (const outcome of [
  "success",
  "failure",
  "sync failure",
  "interrupt",
] as const) {
  test(`image input leases are released when a turn ends with ${outcome}`, async (t) => {
    const f = await modelTestHub();
    const released: number[] = [];
    t.mock.method(
      ImageInputs.prototype,
      "prepare",
      async (content: UserInput) => {
        const index = released.push(0) - 1;
        return {
          content,
          release() {
            released[index]++;
          },
        };
      },
    );
    f.driver.runTurn = async ({ signal, context }) => {
      if (outcome === "interrupt")
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      if (outcome === "failure") throw new Error("fixture failed");
      context.setState(outcome === "interrupt" ? "interrupted" : "idle");
    };
    if (outcome === "sync failure") {
      f.driver.runTurn = () => {
        throw new Error("synchronous driver failure");
      };
    }
    const content: UserInput = [
      { type: "image", mediaType: "image/png", data: "aW1hZ2U=" },
    ];
    try {
      const { ref } = await f.hub.createSession(
        f.socket,
        "codex",
        f.projectId,
        f.cwd,
        "lease",
        content,
        fixtureModelSettings,
      );
      assert.equal(released.length, 1);
      assert.equal(f.repository.get(ref.sessionId)?.lifecycle, "active");
      if (outcome === "interrupt") assert.equal(released[0], 0);
    } finally {
      await f.hub.close();
    }
    assert.deepEqual(released, [1]);
  });
}

test("creation transfers one image lease through allocation and execution while releasing duplicate requests", async (t) => {
  const f = await modelTestHub();
  const content = await imageContent();
  const leases = trackInputLeases(t);
  let entered!: () => void, releaseAllocation!: () => void;
  const allocated = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releaseAllocation = resolve;
  });
  const allocate = f.driver.createSession.bind(f.driver);
  f.driver.createSession = async (input) => {
    entered();
    await gate;
    return allocate(input);
  };
  let sentContent: UserInput | undefined;
  const run = f.driver.runTurn.bind(f.driver);
  f.driver.runTurn = (input) => {
    sentContent = input.content;
    return run(input);
  };
  const create = (input = content) =>
    f.hub.createSession(
      f.socket,
      "codex",
      f.projectId,
      f.cwd,
      "shared-images",
      input,
      fixtureModelSettings,
    );
  const first = create();
  let second: ReturnType<typeof create> | undefined;
  try {
    await allocated;
    assert.deepEqual(
      leases.map((lease) => lease.releases),
      [0],
    );
    second = create();
    await assert.rejects(
      create([...content, { type: "text", text: "different" }]),
      /different parameters/,
    );
    releaseAllocation();
    const [a, b] = await Promise.all([first, second]);
    assert.deepEqual(a.ref, b.ref);
    assert.equal(f.allocations(), 1);
    assert.equal(f.received.length, 1);
    assert.equal(sentContent, leases[0]!.content);
    assert.deepEqual(leases.map((lease) => lease.releases).sort(), [0, 1, 1]);
    f.setReady(false);
    await create();
    assert.equal(f.received.length, 1);
    assert.equal(leases.length, 4);
    assert.equal(leases[3]!.releases, 1);
  } finally {
    releaseAllocation();
    await Promise.allSettled([first, ...(second ? [second] : [])]);
    await f.hub.close();
  }
  assert.deepEqual(
    leases.map((lease) => lease.releases),
    [1, 1, 1, 1],
  );
});

for (const failure of ["allocation", "model recheck", "acceptance"] as const) {
  test(`creation releases its image lease exactly once on ${failure} failure`, async (t) => {
    const f = await modelTestHub();
    const content = await imageContent();
    const leases = trackInputLeases(t);
    if (failure === "allocation") {
      f.driver.createSession = async () => {
        throw new Error("allocation failed");
      };
    } else if (failure === "model recheck") {
      const list = f.hub.listModels.bind(f.hub);
      let calls = 0;
      t.mock.method(f.hub, "listModels", (...args: Parameters<typeof list>) => {
        if (++calls === 2) throw new Error("model recheck failed");
        return list(...args);
      });
    } else {
      t.mock.method(f.repository, "acceptTurn", () => {
        throw new Error("acceptance failed");
      });
    }
    try {
      await assert.rejects(
        f.hub.createSession(
          f.socket,
          "codex",
          f.projectId,
          f.cwd,
          "lease-failure",
          content,
          fixtureModelSettings,
        ),
        /failed/,
      );
      assert.deepEqual(
        leases.map((lease) => lease.releases),
        [1],
      );
      assert.equal(f.received.length, 0);
      assert.equal(
        f.repository.list()[0]!.lifecycle,
        failure === "acceptance" ? "provisioning" : "failed",
      );
    } finally {
      await f.hub.close();
    }
    assert.deepEqual(
      leases.map((lease) => lease.releases),
      [1],
    );
  });
}

test("shutdown while preparing a new image request releases the late lease without allocating", async (t) => {
  const f = await modelTestHub();
  const content = await imageContent();
  const prepare = ImageInputs.prototype.prepare;
  let entered!: () => void, finishPreparation!: () => void;
  const prepared = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    finishPreparation = resolve;
  });
  let releases = 0;
  t.mock.method(
    ImageInputs.prototype,
    "prepare",
    async function (this: ImageInputs, input: UserInput) {
      const lease = await prepare.call(this, input);
      entered();
      await gate;
      return {
        content: lease.content,
        release() {
          releases++;
          lease.release();
        },
      };
    },
  );
  const creating = f.hub.createSession(
    f.socket,
    "codex",
    f.projectId,
    f.cwd,
    "closing-images",
    content,
    fixtureModelSettings,
  );
  const rejected = assert.rejects(creating, /closed/);
  try {
    await prepared;
    await f.hub.close();
  } finally {
    finishPreparation();
    await rejected;
    await f.hub.close();
  }
  assert.equal(releases, 1);
  assert.equal(f.allocations(), 0);
  assert.equal(f.received.length, 0);
});

test("native cancellation closes only its question and never displays a pre-aborted question", async () => {
  const f = await modelTestHub();
  const sent: ServerMessage[] = [];
  const first = new AbortController();
  const pre = new AbortController();
  pre.abort(new Error("Already withdrawn"));
  let finish!: () => void;
  let questions!: Promise<PromiseSettledResult<unknown>[]>;
  f.driver.runTurn = async ({ context }) => {
    questions = Promise.allSettled([
      context.requestInteraction(
        { title: "first", sourceAgentId: "child-a", questions: [] },
        first.signal,
      ),
      context.requestInteraction({
        title: "second",
        sourceAgentId: "child-b",
        questions: [],
      }),
      context.requestInteraction({ title: "never", questions: [] }, pre.signal),
    ]);
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
  };
  try {
    const { ref } = await f.hub.createSession(
      recordingSocket(sent),
      "codex",
      f.projectId,
      f.cwd,
      "native-questions",
      [{ type: "text", text: "Ask" }],
      fixtureModelSettings,
    );
    const initial = await f.hub.snapshot(ref);
    assert.equal(initial?.pendingInteractions.length, 2);
    assert.deepEqual(
      initial?.pendingInteractions.map((x) => x.sourceAgentId),
      ["child-a", "child-b"],
    );
    const [a, b] = initial!.pendingInteractions;
    first.abort(new Error("Only first withdrawn"));
    assert.equal(f.hub.listSessions()[0].state, "waiting_interaction");
    assert.deepEqual(
      (await f.hub.snapshot(ref))?.pendingInteractions.map((x) => x.id),
      [b.id],
    );
    assert.equal(f.hub.resolveInteraction(a.id, { decision: "deny" }), false);
    assert.equal(
      f.hub.resolveInteraction(b.id, { decision: "answer", answers: {} }),
      true,
    );
    assert.equal(f.hub.listSessions()[0].state, "running");
    assert.deepEqual(
      (await questions).map((x) => x.status),
      ["rejected", "fulfilled", "rejected"],
    );
    assert.deepEqual(
      sent.flatMap((x) =>
        x.type === "interaction.resolved" ? [x.interactionId] : [],
      ),
      [a.id, b.id],
    );
    assert.equal(
      sent.filter((x) => x.type === "interaction.requested").length,
      2,
    );
    finish();
  } finally {
    finish?.();
    await f.hub.close();
  }
});
