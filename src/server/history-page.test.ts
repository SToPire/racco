import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTimelineEvent, TimelineEvent } from "../shared/protocol.js";
import { buildTimeline } from "../web/store.js";
import { HistoryCursorError, memoryHistoryPage } from "./history-page.js";

function history(): AgentTimelineEvent[] {
  return Array.from({ length: 25 }, (_, index): AgentTimelineEvent[] => [
    { type: "user.message", id: `u${index}`, text: `request ${index}` },
    { type: "tool.started", id: `t${index}`, tool: "test", input: {} },
    {
      type: "tool.completed",
      id: `t${index}`,
      status: "completed",
      output: "done",
    },
    { type: "assistant.message", id: `a${index}`, text: `answer ${index}` },
  ]).flat();
}

test("tail pages preserve complete tool rows, late updates and boundaries while new turns arrive", () => {
  const events = history();
  events.push({
    type: "assistant.message",
    id: "a3",
    text: "updated old answer",
  });
  const first = memoryHistoryPage(events, "s", "g");
  assert.deepEqual(
    first.events
      .filter((event) => event.type === "user.message")
      .map((event) => event.id),
    Array.from({ length: 10 }, (_, i) => `u${i + 15}`),
  );
  assert(first.nextCursor);
  events.push({ type: "user.message", id: "new", text: "new turn" });
  const second = memoryHistoryPage(
    events,
    "s",
    "g",
    undefined,
    first.nextCursor,
  );
  assert.equal(second.events[0].id, "u5");
  assert(second.nextCursor);
  const last = memoryHistoryPage(
    events,
    "s",
    "g",
    undefined,
    second.nextCursor,
  );
  assert.equal(last.nextCursor, null);
  assert.equal(
    buildTimeline(last.events).find((row) => row.id === "a3")?.type,
    "assistant.message",
  );
  assert.equal(
    last.events.find(
      (event) => event.id === "a3" && event.type === "assistant.message",
    )?.type,
    "assistant.message",
  );
  assert.deepEqual(
    buildTimeline(first.events)
      .filter((row) => row.type === "tool")
      .map((row) => row.status),
    Array(10).fill("completed"),
  );
});

test("cursors reject another session, agent, generation and malformed boundaries", () => {
  const page = memoryHistoryPage(history(), "s", "g");
  for (const [session, generation, agent] of [
    ["other", "g", undefined],
    ["s", "new", undefined],
    ["s", "g", "child"],
  ]) {
    assert.throws(
      () =>
        memoryHistoryPage(
          history(),
          session!,
          generation!,
          agent,
          page.nextCursor!,
        ),
      HistoryCursorError,
    );
  }
  assert.throws(
    () => memoryHistoryPage(history(), "s", "g", undefined, "bad"),
    HistoryCursorError,
  );
});

test("root pages contain child summaries but child content is loaded separately", () => {
  const events: TimelineEvent[] = [
    ...history(),
    {
      type: "subagent.started",
      id: "child-meta",
      agentId: "child",
      name: "worker",
    },
    {
      type: "subagent.state",
      id: "child-state",
      agentId: "child",
      state: "completed",
    },
    ...history().map((event): TimelineEvent => ({
      type: "subagent.event",
      id: `child:${event.id}`,
      agentId: "child",
      event,
    })),
  ];
  const root = memoryHistoryPage(events, "s", "g");
  assert(!root.events.some((event) => event.type === "subagent.event"));
  assert(root.events.some((event) => event.type === "subagent.started"));
  const child = memoryHistoryPage(events, "s", "g", "child");
  assert.equal(
    child.events.filter(
      (event) =>
        event.type === "subagent.event" && event.event.type === "user.message",
    ).length,
    10,
  );
  assert(child.nextCursor);
  const childRow = buildTimeline(child.events).find(
    (row) => row.type === "subagent",
  );
  assert.equal(childRow?.state, "completed");
  assert.equal(childRow?.name, "worker");
});

test("a page materializes streamed prefixes without changing their final timeline", () => {
  const events = history();
  for (let index = 0; index < 100; index++)
    events.push({
      type: "assistant.message",
      id: "a24",
      text: `prefix ${index}`,
    });
  events.push({ type: "tool.output", id: "t24", output: "late output" });
  events.push({ type: "assistant.message.removed", id: "a23" });
  const page = memoryHistoryPage(events, "s", "g");
  assert.equal(page.events.filter((event) => event.id === "a24").length, 1);
  assert.deepEqual(
    buildTimeline(page.events),
    buildTimeline(events).filter((row) => Number(row.id.slice(1)) >= 15),
  );
});
