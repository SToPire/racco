import assert from "node:assert/strict";
import { temporaryImages } from "../../../../test/images.js";
import { setImmediate } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import type { SessionState, TimelineEvent } from "../../../shared/protocol.js";
import { buildTimeline } from "../../../web/store.js";
import { CodexAppServerClient } from "./app-server-client.js";
import { CodexDriver } from "./codex-driver.js";
import type {
  CodexThread,
  CodexThreadItem,
  CodexTurn,
  JsonRpcNotification,
} from "./types.js";

function interaction(
  target: string,
  kind: "activity" | "collab",
): CodexThreadItem {
  return kind === "activity"
    ? {
        type: "subAgentActivity",
        id: `send-${target}`,
        kind: "interacted",
        agentThreadId: target,
        agentPath: target === "root" ? "/root" : `/root/${target}`,
      }
    : {
        type: "collabAgentToolCall",
        id: `send-${target}`,
        tool: "sendMessage",
        status: "completed",
        senderThreadId: "child",
        receiverThreadIds: [target],
        prompt: null,
        model: null,
        reasoningEffort: null,
        agentsStates: { [target]: { status: "running", message: "Delivered" } },
      };
}

async function fixture(t: TestContext) {
  let notify!: (notification: JsonRpcNotification) => void;
  let turnNumber = 0;
  const root: CodexThread = {
    id: "root",
    cwd: process.cwd(),
    preview: "Ownership",
    name: null,
    createdAt: 1700000000,
    updatedAt: 1700000001,
    status: { type: "idle" },
    parentThreadId: null,
    agentNickname: null,
    agentRole: null,
    source: "appServer",
    turns: [],
  };
  const children: CodexThread[] = [];
  const events: TimelineEvent[] = [];
  const states: SessionState[] = [];
  const pending: Promise<void>[] = [];
  t.mock.method(CodexAppServerClient.prototype, "start", async () => {});
  t.mock.method(CodexAppServerClient.prototype, "close", async () => {});
  t.mock.method(
    CodexAppServerClient.prototype,
    "onNotification",
    (listener: typeof notify) => {
      notify = listener;
    },
  );
  t.mock.method(
    CodexAppServerClient.prototype,
    "request",
    async (method: string, params: { threadId?: string }) => {
      if (method === "thread/start") return { thread: root };
      if (method === "thread/list")
        return { data: structuredClone(children), nextCursor: null };
      if (method === "thread/read") {
        const thread =
          params.threadId === root.id
            ? root
            : children.find((child) => child.id === params.threadId);
        assert(thread);
        return { thread: structuredClone(thread) };
      }
      assert.equal(method, "turn/start");
      return {
        turn: {
          id: `main-${++turnNumber}`,
          items: [],
          status: "inProgress",
          error: null,
        },
      };
    },
  );
  const driver = new CodexDriver(
    { info() {}, warn() {} },
    await temporaryImages(),
  );
  t.after(async () => {
    await driver.close();
    await Promise.all(pending);
  });
  await driver.start();
  const modelSettings = { modelId: "model", reasoningEffort: null };
  const handle = await driver.createSession({
    raccoSessionId: "session",
    cwd: root.cwd,
    modelSettings,
  });
  const emit = (
    threadId: string,
    method: string,
    params: Record<string, unknown>,
  ) => notify({ method, params: { threadId, ...params } });
  return {
    driver,
    handle,
    root,
    children,
    events,
    states,
    emit,
    child(id = "child", parentThreadId = "root") {
      const thread: CodexThread = {
        ...root,
        id,
        parentThreadId,
        agentNickname: id,
        turns: [],
      };
      children.push(thread);
      return thread;
    },
    started(thread: CodexThread) {
      notify({ method: "thread/started", params: { thread } });
    },
    async begin() {
      let outcome = "pending";
      const completion = driver
        .runTurn({
          handle,
          mode: "resume",
          content: [{ type: "text", text: "Continue" }],
          modelSettings,
          signal: new AbortController().signal,
          context: {
            emit: (event) => events.push(event),
            setState: (state) => states.push(state),
            markProviderMaterialized() {},
            async requestInteraction() {
              throw new Error("Unexpected interaction");
            },
          },
        })
        .then(
          () => {
            outcome = "completed";
          },
          (error: Error) => {
            outcome = error.message;
          },
        );
      pending.push(completion);
      await setImmediate();
      assert.equal(outcome, "pending");
      const turn: CodexTurn = {
        id: `main-${turnNumber}`,
        items: [],
        status: "inProgress",
        error: null,
      };
      emit(root.id, "turn/started", { turn });
      return {
        async finish() {
          const item: CodexThreadItem = {
            type: "agentMessage",
            id: `${turn.id}-answer`,
            text: `${turn.id} finished`,
            phase: "final_answer",
          };
          emit(root.id, "item/started", {
            turnId: turn.id,
            item: { ...item, text: "" },
          });
          emit(root.id, "item/completed", { turnId: turn.id, item });
          emit(root.id, "turn/completed", {
            turn: { ...turn, status: "completed", items: [item] },
          });
          await setImmediate();
          assert.equal(outcome, "completed", "main turn must settle");
          assert(
            buildTimeline(events).some(
              (row) => row.type === "assistant.message" && row.id === item.id,
            ),
            "the main answer must remain in the main conversation",
          );
        },
      };
    },
  };
}

for (const kind of ["activity", "collab"] as const) {
  test(`${kind} launch records establish child output ownership without thread/started`, async (t) => {
    const f = await fixture(t);
    const turn = await f.begin();
    const launch = interaction("child", kind);
    if (launch.type === "subAgentActivity") launch.kind = "started";
    else if (launch.type === "collabAgentToolCall") launch.tool = "spawnAgent";
    f.emit("root", "item/completed", { turnId: "main-1", item: launch });
    f.emit("child", "item/completed", {
      turnId: "child-turn",
      item: {
        type: "agentMessage",
        id: "child-answer",
        text: "Child finished",
        phase: "final_answer",
      },
    });
    await turn.finish();
    const children = buildTimeline(f.events).filter(
      (row) => row.type === "subagent",
    );
    assert.equal(children.length, 1);
    assert(
      children[0].timeline.some(
        (row) =>
          row.type === "assistant.message" && row.text === "Child finished",
      ),
    );
  });

  for (const source of ["live", "history", "active-snapshot"] as const) {
    test(`${kind} communication to the root preserves main ownership through ${source} and the next turn`, async (t) => {
      const f = await fixture(t);
      const child = f.child();
      const item = interaction("root", kind);
      if (source !== "live") {
        child.turns = [
          {
            id: "child-turn",
            status: source === "history" ? "completed" : "inProgress",
            error: null,
            items: [item],
          },
        ];
      }
      if (source === "history") {
        const snapshot = await f.driver.readSession(f.handle);
        f.events.push(...snapshot.events);
      }
      const first = await f.begin();
      if (source !== "history") f.started(child);
      if (source === "live") {
        for (const method of ["item/started", "item/completed"])
          f.emit(child.id, method, { turnId: "child-turn", item });
      }
      await first.finish();
      await (await f.begin()).finish();
      const rows = buildTimeline(f.events);
      assert.equal(rows.filter((row) => row.type === "subagent").length, 1);
      assert.deepEqual(f.states, ["running", "idle", "running", "idle"]);
    });
  }

  test(`${kind} communication preserves nested parents and peers without inventing unknown recipients`, async (t) => {
    const f = await fixture(t);
    const parent = f.child("parent");
    const peer = f.child("peer");
    const child = f.child("child", parent.id);
    const turn = await f.begin();
    for (const thread of [parent, peer, child]) f.started(thread);
    const before = buildTimeline(f.events).filter(
      (row) => row.type === "subagent",
    );
    for (const target of ["root", "parent", "peer", "unknown"])
      f.emit(child.id, "item/completed", {
        turnId: "child-turn",
        item: interaction(target, kind),
      });
    await turn.finish();
    const after = buildTimeline(f.events).filter(
      (row) => row.type === "subagent",
    );
    assert.deepEqual(
      after.map((row) => [row.agentId, row.parentAgentId]),
      before.map((row) => [row.agentId, row.parentAgentId]),
    );
    assert.equal(
      after.find((row) => row.name === "child")?.parentAgentId,
      after.find((row) => row.name === "parent")?.agentId,
    );
    for (const name of ["parent", "peer"])
      assert.equal(after.find((row) => row.name === name)?.state, "running");
  });
}

test("native child discovery rejects a root identity before it can change main routing", async (t) => {
  const f = await fixture(t);
  f.children.push(f.root);
  await assert.rejects(f.driver.readSession(f.handle), /subagent/i);
  await (await f.begin()).finish();
});
