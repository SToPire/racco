import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTimelineEvent } from "../../../shared/protocol.js";
import { buildTimeline } from "../../../web/store.js";
import { CodexActivityMapper } from "./activity-mapper.js";
import { mapItemEvents } from "./event-mapper.js";
import type { CodexThreadItem, JsonRpcNotification } from "./types.js";

function itemNotification(
  method: "item/started" | "item/completed",
  item: CodexThreadItem,
  threadId = "thread",
  turnId = "turn",
): JsonRpcNotification {
  return { method, params: { threadId, turnId, item } };
}

function delta(
  method: string,
  itemId: string,
  text: string,
  extra = {},
): JsonRpcNotification {
  return {
    method,
    params: {
      threadId: "thread",
      turnId: "turn",
      itemId,
      delta: text,
      ...extra,
    },
  };
}

test("live public reasoning, plans and message phases converge to the native history projection", () => {
  const mapper = new CodexActivityMapper();
  const events: AgentTimelineEvent[] = [];
  const emit = (notification: JsonRpcNotification) => {
    events.push(...(mapper.map(notification) ?? []));
  };
  emit(
    itemNotification("item/started", {
      type: "reasoning",
      id: "reason",
      summary: [],
      content: ["PRIVATE RAW REASONING"],
    }),
  );
  emit(
    delta("item/reasoning/summaryPartAdded", "reason", "", { summaryIndex: 0 }),
  );
  emit(
    delta("item/reasoning/summaryTextDelta", "reason", "Inspect the", {
      summaryIndex: 0,
    }),
  );
  emit(
    delta("item/reasoning/summaryTextDelta", "reason", " protocol", {
      summaryIndex: 0,
    }),
  );
  emit(delta("item/reasoning/textDelta", "reason", "PRIVATE RAW DELTA"));
  emit(
    delta("item/reasoning/summaryTextDelta", "reason", "Verify the result", {
      summaryIndex: 1,
    }),
  );
  const reasoning: CodexThreadItem = {
    type: "reasoning",
    id: "reason",
    summary: ["Inspect the protocol", "Verify the result"],
    content: ["PRIVATE RAW REASONING"],
  };
  emit(itemNotification("item/completed", reasoning));

  emit(
    itemNotification("item/started", {
      type: "plan",
      id: "proposal",
      text: "",
    }),
  );
  emit(delta("item/plan/delta", "proposal", "## Proposed approach\n"));
  emit(delta("item/plan/delta", "proposal", "Update the renderer."));
  const plan: CodexThreadItem = {
    type: "plan",
    id: "proposal",
    text: "## Proposed approach\nUpdate the renderer.",
  };
  emit(itemNotification("item/completed", plan));

  emit(
    itemNotification("item/started", {
      type: "agentMessage",
      id: "progress",
      text: "",
      phase: "commentary",
    }),
  );
  emit(delta("item/agentMessage/delta", "progress", "Checking files"));
  const commentary: CodexThreadItem = {
    type: "agentMessage",
    id: "progress",
    text: "Checking files",
    phase: "commentary",
  };
  emit(itemNotification("item/completed", commentary));
  const answer: CodexThreadItem = {
    type: "agentMessage",
    id: "answer",
    text: "Done",
    phase: "final_answer",
  };
  emit(itemNotification("item/completed", answer));

  const expected = [reasoning, plan, commentary, answer].flatMap((item) =>
    mapItemEvents(item, () => "unused"),
  );
  assert.deepEqual(buildTimeline(events), buildTimeline(expected));
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE RAW/);
  assert(
    events.some(
      (event) =>
        event.type === "assistant.message" &&
        event.partial &&
        event.phase === "commentary",
    ),
  );
  assert(
    events.some(
      (event) =>
        event.type === "assistant.plan" &&
        event.partial &&
        event.text.includes("Proposed approach"),
    ),
  );
  assert.deepEqual(mapper.finish("thread"), []);
});

test("reasoning summary parts preserve prior content and emitted snapshots remain immutable", () => {
  const mapper = new CodexActivityMapper();
  const first = mapper.map(
    delta("item/reasoning/summaryTextDelta", "reason", "First", {
      summaryIndex: 0,
    }),
  );
  mapper.map(
    delta("item/reasoning/summaryPartAdded", "reason", "", { summaryIndex: 0 }),
  );
  const second = mapper.map(
    delta("item/reasoning/summaryTextDelta", "reason", "Second", {
      summaryIndex: 1,
    }),
  );
  assert.deepEqual(first, [
    {
      type: "assistant.reasoning",
      id: "reason",
      summary: ["First"],
      partial: true,
    },
  ]);
  assert.deepEqual(second, [
    {
      type: "assistant.reasoning",
      id: "reason",
      summary: ["First", "Second"],
      partial: true,
    },
  ]);
  assert.throws(
    () =>
      mapper.map(
        delta("item/reasoning/summaryTextDelta", "reason", "invalid", {
          summaryIndex: -1,
        }),
      ),
    /Invalid Codex reasoning summary index/,
  );
});

test("turn checklists update one row without replacing a proposed plan document", () => {
  const mapper = new CodexActivityMapper();
  const plan = mapper.map(
    itemNotification("item/completed", {
      type: "plan",
      id: "proposal",
      text: "The proposed design",
    }),
  )!;
  const update = (status: "pending" | "completed") =>
    mapper.map({
      method: "turn/plan/updated",
      params: {
        threadId: "thread",
        turnId: "turn",
        explanation: null,
        plan: [{ step: "Check the implementation", status }],
      },
    })!;
  const rows = buildTimeline([
    ...plan,
    ...update("pending"),
    ...update("completed"),
  ]);
  assert.deepEqual(rows, [
    { type: "assistant.plan", id: "proposal", text: "The proposed design" },
    {
      type: "plan.updated",
      state: "running",
      id: "turn:plan",
      explanation: null,
      steps: [{ step: "Check the implementation", status: "completed" }],
    },
  ]);
  assert.deepEqual(mapper.finish("thread", "interrupted", "turn"), [
    {
      type: "plan.updated",
      state: "interrupted",
      id: "turn:plan",
      explanation: null,
      steps: [{ step: "Check the implementation", status: "completed" }],
    },
  ]);
  assert.deepEqual(mapper.finish("thread"), []);
});

test("interrupted content is settled per thread and turn without leaking stream state", () => {
  const mapper = new CodexActivityMapper();
  for (const [threadId, turnId] of [
    ["main", "first"],
    ["main", "next"],
    ["child", "first"],
  ]) {
    mapper.map(
      itemNotification(
        "item/started",
        { type: "plan", id: `${turnId}-plan`, text: threadId },
        threadId,
        turnId,
      ),
    );
  }
  assert.deepEqual(mapper.finish("main", "interrupted", "first"), [
    {
      type: "assistant.plan",
      id: "first-plan",
      text: "main",
      stopReason: "interrupted",
    },
  ]);
  assert.deepEqual(mapper.finish("child", "error"), [
    {
      type: "assistant.plan",
      id: "first-plan",
      text: "child",
      stopReason: "error",
    },
  ]);
  assert.deepEqual(mapper.finish("main"), [
    { type: "assistant.plan", id: "next-plan", text: "main" },
  ]);
  assert.deepEqual(mapper.finish("main"), []);
  mapper.clear();
});
