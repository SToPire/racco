import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { WebSocket } from "ws";
import { memoryRepository } from "../../../../test/state.js";
import { SessionHub } from "../../session-hub.js";
import type { ServerMessage, TimelineEvent } from "../../../shared/protocol.js";
import { buildTimeline, type SubagentTimelineRow } from "../../../web/store.js";
import { CodexAppServerClient } from "./app-server-client.js";
import { CodexDriver } from "./codex-driver.js";
import type {
  CodexThread,
  CodexThreadItem,
  JsonRpcNotification,
} from "./types.js";

function fixture(t: TestContext) {
  let notify!: (notification: JsonRpcNotification) => void;
  let childReads = 0;
  let listChild = true;
  let onList: (() => void) | undefined;
  let onRead:
    | ((count: number, threadId: string) => CodexThread | Promise<CodexThread>)
    | undefined;
  const root: CodexThread = {
    id: "root",
    cwd: process.cwd(),
    preview: "Snapshot",
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
  const command: CodexThreadItem = {
    type: "commandExecution",
    id: "command",
    command: "work",
    cwd: process.cwd(),
    status: "inProgress",
    commandActions: [],
    aggregatedOutput: "log prefix",
    exitCode: null,
    durationMs: null,
    processId: null,
    source: "agent",
    pluginId: null,
    scriptPath: null,
  };
  const child: CodexThread = {
    ...root,
    id: "child",
    parentThreadId: "root",
    agentNickname: "Worker",
    status: { type: "active", activeFlags: [] },
    turns: [
      {
        id: "turn",
        status: "inProgress",
        error: null,
        items: [
          command,
          { ...command, id: "empty-command", aggregatedOutput: "" },
          {
            type: "agentMessage",
            id: "finished-text",
            text: "Already finished",
            phase: "commentary",
          },
          {
            type: "agentMessage",
            id: "message",
            text: "text prefix",
            phase: "commentary",
          },
          { type: "plan", id: "plan", text: "plan prefix" },
          {
            type: "reasoning",
            id: "reason",
            summary: ["summary prefix", "second"],
            content: ["PRIVATE RAW"],
          },
        ],
      },
    ],
  };
  const children = [child];
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
      if (method === "thread/list") {
        onList?.();
        return {
          data: listChild ? structuredClone(children) : [],
          nextCursor: null,
        };
      }
      assert.equal(method, "thread/read");
      if (params.threadId === "root") return { thread: structuredClone(root) };
      childReads++;
      const thread = children.find((thread) => thread.id === params.threadId);
      assert(thread);
      return {
        thread: structuredClone(
          onRead ? await onRead(childReads, thread.id) : thread,
        ),
      };
    },
  );
  const driver = new CodexDriver({ info() {}, warn() {} });
  const updates: TimelineEvent[] = [];
  driver.onSessionUpdate((rootId, event) => {
    assert.equal(rootId, "root");
    if (
      event.type === "subagent.started" ||
      event.type === "subagent.event" ||
      event.type === "subagent.state"
    )
      updates.push(event);
  });
  t.after(() => driver.close());
  const emit = (method: string, params: Record<string, unknown>) =>
    notify({
      method,
      params: { threadId: "child", turnId: "turn", ...params },
    });
  const read = () =>
    driver.readSession({ providerSessionId: "root", cwd: process.cwd() });
  const rows = (base: TimelineEvent[] = []) => {
    const row = buildTimeline([...base, ...updates]).find(
      (candidate): candidate is SubagentTimelineRow =>
        candidate.type === "subagent",
    );
    assert(row);
    return row;
  };
  return {
    driver,
    root,
    child,
    children,
    updates,
    emit,
    read,
    rows,
    count: () => childReads,
    setList: (value: typeof onList) => {
      onList = value;
    },
    setListChild: (value: boolean) => {
      listChild = value;
    },
    setRead: (value: typeof onRead) => {
      onRead = value;
    },
  };
}

function appendAndInterrupt(f: ReturnType<typeof fixture>) {
  f.emit("item/commandExecution/outputDelta", {
    itemId: "command",
    delta: " tail",
  });
  f.emit("item/commandExecution/outputDelta", {
    itemId: "empty-command",
    delta: "only output",
  });
  f.emit("item/agentMessage/delta", { itemId: "message", delta: " tail" });
  f.emit("item/plan/delta", { itemId: "plan", delta: " tail" });
  f.emit("item/reasoning/summaryTextDelta", {
    itemId: "reason",
    summaryIndex: 1,
    delta: " tail",
  });
  f.emit("turn/completed", {
    turn: { id: "turn", status: "interrupted", error: null, items: [] },
  });
}

function checkPrefixes(row: SubagentTimelineRow) {
  const find = (suffix: string) =>
    row.timeline.find((item) => item.id.endsWith(`:${suffix}`));
  const command = find("command");
  assert(command?.type === "tool");
  assert.equal(command.output, "log prefix tail");
  assert.equal(command.status, "interrupted");
  const empty = find("empty-command");
  assert(empty?.type === "tool");
  assert.equal(empty.output, "only output");
  const message = find("message");
  assert(message?.type === "assistant.message");
  assert.equal(message.text, "text prefix tail");
  assert.equal(message.phase, "commentary");
  assert.equal(message.stopReason, "interrupted");
  const plan = find("plan");
  assert(plan?.type === "assistant.plan");
  assert.equal(plan.text, "plan prefix tail");
  const reason = find("reason");
  assert(reason?.type === "assistant.reasoning");
  assert.deepEqual(reason.summary, ["summary prefix", "second tail"]);
  const finished = find("finished-text");
  assert(finished?.type === "assistant.message");
  assert.equal(finished.partial, undefined);
  assert.equal(finished.stopReason, undefined);
  assert.doesNotMatch(JSON.stringify(row), /PRIVATE RAW/);
}

function discoverInRoot(f: ReturnType<typeof fixture>, ids: string[]) {
  f.root.turns = [
    {
      id: "main-turn",
      status: "completed",
      error: null,
      items: [
        {
          type: "collabAgentToolCall",
          id: "spawn",
          tool: "spawnAgent",
          status: "completed",
          senderThreadId: "root",
          receiverThreadIds: ids,
          prompt: "Work",
          model: null,
          reasoningEffort: null,
          agentsStates: Object.fromEntries(
            ids.map((id) => [id, { status: "running", message: null }]),
          ),
        },
      ],
    },
  ];
}

test("a child discovered in root history cannot broadcast a suffix during thread/list", async (t) => {
  const f = fixture(t);
  discoverInRoot(f, ["child"]);
  await f.driver.start();
  f.setList(() => {
    f.emit("item/agentMessage/delta", {
      itemId: "message",
      delta: " during list",
    });
    const message = f.child.turns[0].items.find(
      (item) => item.id === "message",
    );
    assert(message?.type === "agentMessage");
    message.text += " during list";
    f.emit("item/commandExecution/outputDelta", {
      itemId: "command",
      delta: " during list",
    });
    const command = f.child.turns[0].items[0];
    assert(command.type === "commandExecution");
    command.aggregatedOutput += " during list";
    assert.equal(f.updates.length, 0);
  });
  const snapshot = await f.read();
  assert.equal(f.updates.length, 0);
  assert.equal(f.count(), 1);
  f.emit("item/agentMessage/delta", {
    itemId: "message",
    delta: " after read",
  });
  f.emit("item/commandExecution/outputDelta", {
    itemId: "command",
    delta: " after read",
  });
  f.emit("turn/completed", {
    turn: { id: "turn", status: "interrupted", items: [], error: null },
  });
  const child = f.rows(snapshot.events);
  const message = child.timeline.find((row) => row.id.endsWith(":message"));
  assert(message?.type === "assistant.message");
  assert.equal(message.text, "text prefix during list after read");
  assert.equal(message.phase, "commentary");
  assert.equal(message.stopReason, "interrupted");
  const command = child.timeline.find((row) => row.id.endsWith(":command"));
  assert(command?.type === "tool");
  assert.equal(command.output, "log prefix during list after read");
  assert.equal(command.status, "interrupted");
});

for (const discovery of ["root history", "thread/list"]) {
  test(`an unseeded child from ${discovery} stays protected while another child is read`, async (t) => {
    const f = fixture(t);
    const second = structuredClone(f.child);
    second.id = "second";
    second.agentNickname = "Second";
    second.turns[0].id = "second-turn";
    f.children.push(second);
    discoverInRoot(
      f,
      discovery === "root history" ? ["child", "second"] : ["child"],
    );
    await f.driver.start();
    f.setRead((_count, threadId) => {
      if (threadId === "child") {
        const message = second.turns[0].items.find(
          (item) => item.id === "message",
        );
        assert(message?.type === "agentMessage");
        f.emit("item/agentMessage/delta", {
          threadId: "second",
          turnId: "second-turn",
          itemId: "message",
          delta: " before its read",
        });
        message.text += " before its read";
        const command = second.turns[0].items[0];
        assert(command.type === "commandExecution");
        f.emit("item/commandExecution/outputDelta", {
          threadId: "second",
          turnId: "second-turn",
          itemId: "command",
          delta: " before its read",
        });
        command.aggregatedOutput += " before its read";
        assert.equal(f.updates.length, 0);
        // An absolute item start provides a trustworthy baseline immediately,
        // even though this child's snapshot RPC has not started yet.
        f.emit("item/started", {
          threadId: "second",
          turnId: "second-turn",
          item: structuredClone(message),
        });
        f.emit("item/agentMessage/delta", {
          threadId: "second",
          turnId: "second-turn",
          itemId: "message",
          delta: " anchored",
        });
        message.text += " anchored";
        assert(
          f.updates.some(
            (event) =>
              event.type === "subagent.event" &&
              event.event.type === "assistant.message" &&
              event.event.text === "text prefix before its read anchored" &&
              event.event.phase === "commentary",
          ),
        );
        return f.child;
      }
      return second;
    });
    const snapshot = await f.read();
    assert.equal(f.count(), 2);
    f.emit("item/agentMessage/delta", {
      threadId: "second",
      turnId: "second-turn",
      itemId: "message",
      delta: " after its read",
    });
    f.emit("item/commandExecution/outputDelta", {
      threadId: "second",
      turnId: "second-turn",
      itemId: "command",
      delta: " after its read",
    });
    f.emit("turn/completed", {
      threadId: "second",
      turn: {
        id: "second-turn",
        status: "interrupted",
        items: [],
        error: null,
      },
    });
    const child = buildTimeline([...snapshot.events, ...f.updates]).find(
      (row) => row.type === "subagent" && row.name === "Second",
    );
    assert(child?.type === "subagent");
    const message = child.timeline.find((row) => row.id.endsWith(":message"));
    assert(message?.type === "assistant.message");
    assert.equal(
      message.text,
      "text prefix before its read anchored after its read",
    );
    assert.equal(message.phase, "commentary");
    assert.equal(message.stopReason, "interrupted");
    const command = child.timeline.find((row) => row.id.endsWith(":command"));
    assert(command?.type === "tool");
    assert.equal(command.output, "log prefix before its read after its read");
  });
}

test("first active child snapshot preserves every public prefix and leaves completed text dormant", async (t) => {
  const f = fixture(t);
  await f.driver.start();
  const snapshot = await f.read();
  assert.equal(f.updates.length, 0);
  appendAndInterrupt(f);
  checkPrefixes(f.rows(snapshot.events));
  assert.equal(f.count(), 1);
  assert.equal(
    f.updates.filter(
      (event) =>
        event.type === "subagent.event" &&
        event.event.id.endsWith(":finished-text"),
    ).length,
    0,
  );
  const count = f.updates.length;
  await f.driver.close();
  assert.equal(f.updates.length, count);
});

test("thread/started with existing turn content establishes the same continuation baseline", async (t) => {
  const f = fixture(t);
  f.setListChild(false);
  await f.driver.start();
  await f.read();
  f.emit("thread/started", { thread: structuredClone(f.child) });
  appendAndInterrupt(f);
  checkPrefixes(f.rows());
  assert.equal(f.count(), 0);
});

test("a repeated thread/started snapshot does not publish older text over a live continuation", async (t) => {
  const f = fixture(t);
  f.setListChild(false);
  await f.driver.start();
  await f.read();
  f.emit("thread/started", { thread: structuredClone(f.child) });
  f.emit("item/agentMessage/delta", {
    itemId: "message",
    delta: " live continuation",
  });
  f.emit("item/commandExecution/outputDelta", {
    itemId: "command",
    delta: " live output",
  });
  f.emit("thread/started", { thread: structuredClone(f.child) });
  const row = f.rows();
  const message = row.timeline.find((item) => item.id.endsWith(":message"));
  assert(message?.type === "assistant.message");
  assert.equal(message.text, "text prefix live continuation");
  const command = row.timeline[0];
  assert(command.type === "tool");
  assert.equal(command.output, "log prefix live output");
});

test("late repeated snapshots cannot replace a newer delta or resurrect an item completed during the RPC", async (t) => {
  const f = fixture(t);
  await f.driver.start();
  const snapshot = await f.read();
  f.emit("item/agentMessage/delta", { itemId: "message", delta: " newer" });
  f.setRead(() => {
    f.emit("item/agentMessage/delta", {
      itemId: "message",
      delta: " during read",
    });
    f.emit("item/completed", {
      item: {
        ...f.child.turns[0].items[0],
        status: "completed",
        aggregatedOutput: "authoritative result",
        exitCode: 0,
      },
    });
    return f.child;
  });
  await f.read();
  f.emit("item/agentMessage/delta", {
    itemId: "message",
    delta: " after read",
  });
  f.emit("turn/completed", {
    turn: { id: "turn", status: "interrupted", error: null, items: [] },
  });
  const child = f.rows(snapshot.events);
  const message = child.timeline.find(
    (row) => row.type === "assistant.message" && row.id.endsWith(":message"),
  );
  assert(message?.type === "assistant.message");
  assert.equal(message.text, "text prefix newer during read after read");
  assert.equal(message.phase, "commentary");
  const command = child.timeline.find(
    (row) => row.type === "tool" && row.id.endsWith(":command"),
  );
  assert(command?.type === "tool");
  assert.equal(command.status, "completed");
  assert.equal(command.output, "authoritative result");
  assert.equal(f.count(), 2);
});

test("a native terminal observed before a later stale read cannot revive the old turn", async (t) => {
  const f = fixture(t);
  await f.driver.start();
  const snapshot = await f.read();
  f.emit("item/completed", {
    item: {
      ...f.child.turns[0].items[0],
      status: "completed",
      aggregatedOutput: "finished result",
      exitCode: 0,
    },
  });
  f.emit("item/completed", {
    item: {
      type: "agentMessage",
      id: "message",
      text: "Finished answer",
      phase: "final_answer",
    },
  });
  // The old item is also protected while other items in this turn are running.
  await assert.rejects(f.read(), /快照早于已观测的工具终态/);
  f.emit("turn/completed", {
    turn: { id: "turn", status: "completed", items: [], error: null },
  });
  const stoppedCount = f.updates.length;
  await assert.rejects(f.read(), /快照早于已观测的轮次状态/); // Native mock deliberately returns the earlier inProgress view.
  await f.driver.close();
  assert.equal(f.updates.length, stoppedCount);
  const child = f.rows(snapshot.events);
  assert.equal(child.state, "completed");
  const message = child.timeline.find((row) => row.id.endsWith(":message"));
  assert(message?.type === "assistant.message");
  assert.equal(message.text, "Finished answer");
  assert.equal(message.stopReason, undefined);
  const command = child.timeline[0];
  assert(command.type === "tool");
  assert.equal(command.status, "completed");
  assert.equal(command.output, "finished result");
});

function setSnapshotPrefix(f: ReturnType<typeof fixture>, prefix: string) {
  for (const item of f.child.turns[0].items) {
    if (item.type === "commandExecution") item.aggregatedOutput = prefix;
    else if (item.type === "agentMessage" || item.type === "plan")
      item.text = prefix;
    else if (item.type === "reasoning") item.summary = [prefix];
  }
}

function assertSnapshotPrefixContinuation(
  f: ReturnType<typeof fixture>,
  snapshot: TimelineEvent[],
  expected: string,
) {
  f.emit("item/commandExecution/outputDelta", {
    itemId: "command",
    delta: " tail",
  });
  f.emit("item/agentMessage/delta", { itemId: "message", delta: " tail" });
  f.emit("item/plan/delta", { itemId: "plan", delta: " tail" });
  f.emit("item/reasoning/summaryTextDelta", {
    itemId: "reason",
    summaryIndex: 0,
    delta: " tail",
  });
  for (const row of f.rows(snapshot).timeline) {
    if (row.id.endsWith(":command") && row.type === "tool")
      assert.equal(row.output, expected);
    if (row.id.endsWith(":message") && row.type === "assistant.message") {
      assert.equal(row.text, expected);
      assert.equal(row.phase, "commentary");
    }
    if (row.type === "assistant.plan") assert.equal(row.text, expected);
    if (row.type === "assistant.reasoning")
      assert.deepEqual(row.summary, [expected]);
  }
}

test("a more complete snapshot advances dormant baselines before the first live delta", async (t) => {
  const f = fixture(t);
  await f.driver.start();
  await f.read();
  setSnapshotPrefix(f, "longer snapshot prefix");
  const snapshot = await f.read();
  assert.equal(f.updates.length, 0);
  assertSnapshotPrefixContinuation(
    f,
    snapshot.events,
    "longer snapshot prefix tail",
  );
  assert.equal(f.count(), 2);
});

test("concurrent snapshot reads returning out of order retain the newer dormant baseline", async (t) => {
  const f = fixture(t);
  await f.driver.start();
  await f.read();
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slowStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.setRead(async (count) => {
    if (count === 2) {
      const old = structuredClone(f.child);
      started();
      await gate;
      return old;
    }
    return f.child;
  });
  const slow = f.read();
  await slowStarted;
  setSnapshotPrefix(f, "newer snapshot");
  const latest = await f.read();
  release();
  await slow;
  assertSnapshotPrefixContinuation(f, latest.events, "newer snapshot tail");
  assert.equal(f.count(), 3);
});

test("a first-read race gets one bounded retry and never broadcasts an unaligned suffix", async (t) => {
  const f = fixture(t);
  await f.driver.start();
  f.setRead((count) => {
    const old = structuredClone(f.child);
    if (count === 1) {
      f.emit("item/commandExecution/outputDelta", {
        itemId: "command",
        delta: " raced",
      });
      const command = f.child.turns[0].items[0];
      assert(command.type === "commandExecution");
      command.aggregatedOutput += " raced";
    }
    return count === 1 ? old : f.child;
  });
  const snapshot = await f.read();
  assert.equal(f.count(), 2);
  assert.equal(f.updates.length, 0);
  f.emit("item/commandExecution/outputDelta", {
    itemId: "command",
    delta: " later",
  });
  const command = f.rows(snapshot.events).timeline[0];
  assert(command.type === "tool");
  assert.equal(command.output, "log prefix raced later");
});

test("an interruption racing initial hydration is recovered by the one fresh read without suffix-only messages", async (t) => {
  const f = fixture(t);
  await f.driver.start();
  f.setRead((count) => {
    const old = structuredClone(f.child);
    if (count === 1) {
      f.emit("item/agentMessage/delta", {
        itemId: "message",
        delta: " final fragment",
      });
      const message = f.child.turns[0].items.find(
        (item) => item.id === "message",
      );
      assert(message?.type === "agentMessage");
      message.text += " final fragment";
      f.child.turns[0].status = "interrupted";
      f.child.status = { type: "idle" };
      f.emit("turn/completed", { turn: structuredClone(f.child.turns[0]) });
    }
    return count === 1 ? old : f.child;
  });
  const snapshot = await f.read();
  assert.equal(f.count(), 2);
  const message = f
    .rows(snapshot.events)
    .timeline.find((row) => row.id.endsWith(":message"));
  assert(message?.type === "assistant.message");
  assert.equal(message.text, "text prefix final fragment");
  assert.equal(
    f.updates.some(
      (event) =>
        event.type === "subagent.event" &&
        event.event.type === "assistant.message",
    ),
    false,
  );
  const count = f.updates.length;
  await f.driver.close();
  assert.equal(f.updates.length, count);
});

for (const warmRoot of [false, true]) {
  test(`Hub reports an interrupted first-child snapshot conflict with ${warmRoot ? "existing" : "uncached"} root history, then recovers on retry`, async (t) => {
    const f = fixture(t);
    await f.driver.start();
    f.root.turns = [
      {
        id: "root-turn",
        status: "completed",
        error: null,
        items: [
          {
            type: "userMessage",
            id: "root-user",
            content: [{ type: "text", text: "Existing main request" }],
          },
        ],
      },
    ];
    const repository = memoryRepository();
    const project = repository.importProject({
      name: "fixture",
      path: process.cwd(),
    });
    const managed = repository.importSession({
      provider: "codex",
      providerSessionId: "root",
      projectId: project.projectId,
      cwd: process.cwd(),
      updatedAt: "2026-09-22T00:00:00.000Z",
    });
    const hub = new SessionHub([f.driver], repository, process.cwd());
    t.after(() => hub.close());
    const ref = { sessionId: managed.sessionId };
    const sent: ServerMessage[] = [];
    const socket = {
      readyState: WebSocket.OPEN,
      send(value: string) {
        sent.push(JSON.parse(value));
      },
    } as WebSocket;
    if (warmRoot) {
      f.setListChild(false);
      const initial = await hub.subscribe(socket, ref);
      assert(
        initial?.events.some(
          (event) =>
            event.type === "user.message" &&
            event.text === "Existing main request",
        ),
      );
      f.setListChild(true);
    }
    f.setRead((count) => {
      const old = structuredClone(f.child);
      if (count === 1) {
        f.emit("item/agentMessage/delta", {
          itemId: "message",
          delta: " recovered tail",
        });
        const message = f.child.turns[0].items.find(
          (item) => item.id === "message",
        );
        assert(message?.type === "agentMessage");
        message.text += " recovered tail";
        f.child.turns[0].status = "interrupted";
        f.child.status = { type: "idle" };
        f.emit("turn/completed", { turn: structuredClone(f.child.turns[0]) });
      }
      return count === 1 ? old : f.child;
    });
    const conflicted = await hub.subscribe(socket, ref);
    assert(conflicted);
    assert.equal(f.count(), 2);
    assert(
      conflicted.events.some(
        (event) =>
          event.type === "system.notice" &&
          event.level === "warning" &&
          /本次未更新完整历史，请重试/.test(event.text),
      ),
    );
    const incompleteChild = buildTimeline(conflicted.events).find(
      (row) => row.type === "subagent",
    );
    assert(incompleteChild?.type === "subagent");
    assert.equal(incompleteChild.state, "interrupted");
    assert.deepEqual(incompleteChild.timeline, []);
    assert.equal(
      conflicted.events.some((event) => event.type === "user.message"),
      warmRoot,
    );
    assert.equal(
      sent.some(
        (message) =>
          message.type === "timeline.event" &&
          message.event.type === "subagent.event" &&
          message.event.event.type === "assistant.message" &&
          message.event.event.text === " recovered tail",
      ),
      false,
    );
    f.setRead(undefined);
    const recovered = await hub.snapshot(ref);
    assert(recovered);
    assert.equal(f.count(), 3);
    assert.equal(
      recovered.events.some(
        (event) =>
          event.type === "system.notice" &&
          /本次未更新完整历史/.test(event.text),
      ),
      false,
    );
    const child = buildTimeline(recovered.events).find(
      (row) => row.type === "subagent",
    );
    assert(child?.type === "subagent");
    const message = child.timeline.find((row) => row.id.endsWith(":message"));
    assert(message?.type === "assistant.message");
    assert.equal(message.text, "text prefix recovered tail");
    assert.equal(message.phase, "commentary");
    assert.equal(child.state, "interrupted");
    assert.equal(recovered.session.state, "idle");
  });
}

test("continuous initial races fail after two reads and recover only from a full item or a later aligned snapshot", async (t) => {
  const f = fixture(t);
  await f.driver.start();
  f.setRead((count) => {
    f.emit("item/commandExecution/outputDelta", {
      itemId: "command",
      delta: `suffix-${count}`,
    });
    f.emit("item/agentMessage/delta", {
      itemId: "message",
      delta: `suffix-${count}`,
    });
    return f.child;
  });
  await assert.rejects(f.read(), /流式快照无法对齐/);
  assert.equal(f.count(), 2);
  assert.equal(f.updates.length, 0);
  f.emit("item/commandExecution/outputDelta", {
    itemId: "command",
    delta: "still unaligned",
  });
  f.emit("item/agentMessage/delta", {
    itemId: "message",
    delta: "still unaligned",
  });
  assert.equal(f.updates.length, 0);
  f.emit("item/started", {
    item: {
      type: "agentMessage",
      id: "message",
      text: "full restored message",
      phase: "commentary",
    },
  });
  f.emit("item/agentMessage/delta", {
    itemId: "message",
    delta: " continuation",
  });
  const message = f
    .rows()
    .timeline.find((row) => row.type === "assistant.message");
  assert(message?.type === "assistant.message");
  assert.equal(message.text, "full restored message continuation");
  f.setRead(undefined);
  const snapshot = await f.read();
  f.emit("item/commandExecution/outputDelta", {
    itemId: "command",
    delta: " recovered",
  });
  const command = f
    .rows(snapshot.events)
    .timeline.find((row) => row.type === "tool" && row.id.endsWith(":command"));
  assert(command?.type === "tool");
  assert.equal(command.output, "log prefix recovered");
  assert.equal(f.count(), 3);
});
