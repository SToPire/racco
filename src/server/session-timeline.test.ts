import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTimelineEvent, TimelineEvent } from "../shared/protocol.js";
import {
  applyTimelineEvent,
  buildTimeline,
  type TimelineRow,
} from "../web/store.js";
import { SessionTimeline } from "./session-timeline.js";

test("compacts cumulative content while preserving replay order and lifecycle barriers", () => {
  const agentEvents: AgentTimelineEvent[] = [
    { type: "assistant.message", id: "answer", text: "prefix", partial: true },
    { type: "system.notice", id: "between", text: "between", level: "info" },
    { type: "assistant.message", id: "answer", text: "complete" },
    { type: "assistant.message.removed", id: "answer" },
    { type: "user.message", id: "next", text: "next", imageCount: 0 },
    { type: "assistant.message", id: "answer", text: "retry", partial: true },
    { type: "assistant.message", id: "answer", text: "retry complete" },
    { type: "tool.started", id: "tool", tool: "command", input: "echo" },
    { type: "tool.output", id: "tool", output: "a" },
    { type: "tool.progress", id: "tool", elapsedSeconds: 1 },
    { type: "tool.output", id: "tool", output: "ab" },
    {
      type: "tool.completed",
      id: "tool",
      output: "completion",
      status: "completed",
    },
    { type: "tool.output", id: "tool", output: "late output" },
    { type: "tool.started", id: "tool", tool: "command", input: "again" },
    { type: "tool.output", id: "tool", output: "new output" },
    {
      type: "assistant.reasoning",
      id: "reason",
      summary: ["a"],
      partial: true,
    },
    { type: "assistant.reasoning", id: "reason", summary: ["ab"] },
    { type: "assistant.plan", id: "plan", text: "a", partial: true },
    { type: "assistant.plan", id: "plan", text: "ab" },
    // Distinct event types with the same ID must retain their replacement order.
    { type: "assistant.message", id: "plan", text: "message" },
    { type: "assistant.plan", id: "plan", text: "restored plan" },
  ];
  const events: TimelineEvent[] = [];
  const timeline = new SessionTimeline();
  let live: TimelineRow[] = [];
  const append = (event: TimelineEvent) => {
    events.push(event);
    timeline.append(event);
    live = applyTimelineEvent(live, event);
    assert.deepEqual(buildTimeline(timeline.snapshot()), live);
    assert.deepEqual(buildTimeline(timeline.snapshot()), buildTimeline(events));
  };
  for (const event of agentEvents) {
    append(event);
    append({
      type: "subagent.event",
      id: `child:${event.type}:${event.id}`,
      agentId: "child",
      event,
    });
  }
  append({
    type: "subagent.started",
    id: "start",
    agentId: "child",
    name: "Child",
  });
  append({
    type: "subagent.started",
    id: "details",
    agentId: "child",
    role: "worker",
  });
  append({
    type: "subagent.state",
    id: "state1",
    agentId: "child",
    state: "running",
  });
  append({
    type: "subagent.state",
    id: "state2",
    agentId: "child",
    state: "completed",
  });
  assert(timeline.snapshot().length < events.length);
  assert.deepEqual(new SessionTimeline(events).snapshot(), timeline.snapshot());
});

test("snapshot text grows linearly with cumulative streaming content", () => {
  const timeline = new SessionTimeline();
  const sizes: number[] = [];
  for (let count = 1; count <= 2000; count++) {
    timeline.append({
      type: "assistant.message",
      id: "answer",
      text: "x".repeat(count * 20),
      partial: true,
    });
    timeline.append({
      type: "tool.output",
      id: "tool",
      output: "y".repeat(count * 20),
    });
    if (count === 1000 || count === 2000)
      sizes.push(JSON.stringify(timeline.snapshot()).length);
  }
  assert.equal(timeline.snapshot().length, 2);
  assert(sizes[1] < sizes[0] * 2.01);
  assert(sizes[1] < 81_000);
});
