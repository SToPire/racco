import assert from "node:assert/strict";
import test from "node:test";
import {
  applyTimelineEvent,
  buildTimeline,
  findTimelineTool,
  groupTimelineRows,
  type AgentTimelineRow,
  type TimelineRow,
} from "./store.js";
import type { TimelineEvent } from "../shared/protocol.js";

test("snapshot building matches streaming across replacements, removals, tools and nested agents", () => {
  const events: TimelineEvent[] = [];
  for (let index = 0; index < 200; index++) {
    const id = String(index);
    events.push(
      { type: "user.message", id: `user-${id}`, text: id },
      {
        type: "tool.started",
        id: `tool-${id}`,
        tool: "shell",
        input: { command: id },
      },
      { type: "tool.completed", id: `tool-${id}`, success: true, output: id },
      {
        type: "assistant.message",
        id: `reply-${id}`,
        text: "partial",
        partial: true,
      },
      { type: "assistant.message.removed", id: `reply-${id}` },
      { type: "assistant.message", id: `reply-${id}`, text: id },
      {
        type: "subagent.event",
        id: `nested-${id}`,
        agentId: "child",
        event: { type: "assistant.message", id: `child-${id}`, text: id },
      },
    );
  }
  events.push({
    type: "subagent.started",
    id: "started",
    agentId: "child",
    name: "child",
  });
  events.push({
    type: "subagent.event",
    id: "removed",
    agentId: "child",
    event: { type: "assistant.message.removed", id: "child-0" },
  });
  assert.deepEqual(
    buildTimeline(events),
    events.reduce<TimelineRow[]>(applyTimelineEvent, []),
  );
});

test("provider progress survives terminal states without reopening calls or changing their recorded output", () => {
  let rows = buildTimeline([
    {
      type: "tool.started",
      id: "call",
      tool: "Bash",
      input: { command: "test" },
    },
    { type: "tool.output", id: "call", output: "last output" },
    {
      type: "tool.progress",
      id: "call",
      elapsedSeconds: 12,
      description: "Running tests",
    },
    { type: "tool.completed", id: "call", status: "interrupted" },
  ]);
  const snapshot = rows;
  rows = applyTimelineEvent(rows, {
    type: "tool.progress",
    id: "call",
    elapsedSeconds: 13,
  });
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert(row.type === "tool");
  assert.equal(row.status, "interrupted");
  assert.equal(row.output, "last output");
  assert.deepEqual(row.progress, { elapsedSeconds: 13 });
  const before = snapshot[0];
  assert(before.type === "tool");
  assert.deepEqual(before.progress, {
    elapsedSeconds: 12,
    description: "Running tests",
  });
  for (const status of [
    "completed",
    "failed",
    "interrupted",
    "incomplete",
  ] as const) {
    const terminal = applyTimelineEvent(rows, {
      type: "tool.completed",
      id: "call",
      status,
    });
    assert(terminal[0].type === "tool");
    assert.equal(terminal[0].status, status);
  }
});

test("materializes reasoning, plan documents and execution checklists as distinct rows for each agent", () => {
  const events: TimelineEvent[] = [
    {
      type: "assistant.reasoning",
      id: "reason",
      summary: ["Inspect"],
      partial: true,
    },
    { type: "assistant.plan", id: "proposal", text: "Initial", partial: true },
    {
      type: "plan.updated",
      state: "running",
      id: "turn:plan",
      explanation: null,
      steps: [{ step: "Implement", status: "pending" }],
    },
    {
      type: "assistant.message",
      id: "commentary",
      text: "Updating the view",
      phase: "commentary",
    },
    {
      type: "subagent.event",
      id: "child-event",
      agentId: "child",
      event: {
        type: "assistant.reasoning",
        id: "child:reason",
        summary: ["Review"],
      },
    },
  ];
  const initial = buildTimeline(events);
  const complete = applyTimelineEvent(
    applyTimelineEvent(
      applyTimelineEvent(initial, {
        type: "assistant.reasoning",
        id: "reason",
        summary: ["Inspect", "Verify"],
      }),
      { type: "assistant.plan", id: "proposal", text: "Final proposal" },
    ),
    {
      type: "plan.updated",
      state: "running",
      id: "turn:plan",
      explanation: "Done",
      steps: [{ step: "Implement", status: "completed" }],
    },
  );
  assert.equal(complete.length, 5);
  assert.deepEqual(complete[0], {
    type: "assistant.reasoning",
    id: "reason",
    summary: ["Inspect", "Verify"],
  });
  assert.deepEqual(initial[0], events[0]);
  assert.equal(
    groupTimelineRows(
      complete.filter(
        (row): row is AgentTimelineRow => row.type !== "subagent",
      ),
    ).every((section) => section.type === "row"),
    true,
  );
  const child = complete[4];
  assert(child.type === "subagent");
  assert.deepEqual(child.timeline, [
    { type: "assistant.reasoning", id: "child:reason", summary: ["Review"] },
  ]);
});

test("groups consecutive tool rows and preserves surrounding messages", () => {
  const rows: AgentTimelineRow[] = [
    { type: "assistant.message", id: "message-1", text: "Checking" },
    {
      type: "tool",
      id: "tool-1",
      tool: "command",
      output: "one",
      status: "completed",
    },
    {
      type: "tool",
      id: "tool-2",
      tool: "command",
      output: "two",
      status: "completed",
    },
    { type: "assistant.message", id: "message-2", text: "Done" },
  ];

  assert.deepEqual(groupTimelineRows(rows), [
    { type: "row", id: "message-1", row: rows[0] },
    {
      type: "tool-group",
      id: "tool-group:tool-1",
      rows: [rows[1], rows[2]],
    },
    { type: "row", id: "message-2", row: rows[3] },
  ]);
});

test("withdraws only the addressed assistant row, including nested rows and replayed removals", () => {
  const events: TimelineEvent[] = [
    { type: "user.message", id: "user", text: "hello" },
    { type: "tool.started", id: "tool", tool: "Read", input: {} },
    { type: "assistant.message", id: "main", text: "partial", partial: true },
    {
      type: "subagent.event",
      id: "child-start",
      agentId: "child",
      event: {
        type: "assistant.message",
        id: "main",
        text: "child partial",
        partial: true,
      },
    },
  ];
  const original = buildTimeline(events);
  const removed = applyTimelineEvent(original, {
    type: "assistant.message.removed",
    id: "main",
  });
  assert.equal(original.length, 4);
  assert.deepEqual(
    removed.map((row) => row.id),
    ["user", "tool", "subagent:child"],
  );
  assert.equal(removed[2]?.type, "subagent");
  assert.deepEqual(
    applyTimelineEvent(removed, {
      type: "assistant.message.removed",
      id: "main",
    }),
    removed,
  );
  assert.deepEqual(
    applyTimelineEvent(removed, {
      type: "assistant.message.removed",
      id: "user",
    }),
    removed,
  );
  assert.deepEqual(
    applyTimelineEvent(removed, {
      type: "assistant.message.removed",
      id: "tool",
    }),
    removed,
  );
  const nestedRemoval: TimelineEvent = {
    type: "subagent.event",
    id: "child-remove",
    agentId: "child",
    event: { type: "assistant.message.removed", id: "main" },
  };
  const cleared = applyTimelineEvent(removed, nestedRemoval);
  assert(cleared[2]?.type === "subagent");
  assert(removed[2]?.type === "subagent");
  assert.deepEqual(cleared[2].timeline, []);
  assert.equal(
    removed[2].timeline.length,
    1,
    "earlier snapshots remain immutable",
  );
});

test("starts a new tool group after a non-tool row", () => {
  const rows: AgentTimelineRow[] = [
    {
      type: "tool",
      id: "tool-1",
      tool: "command",
      output: "one",
      status: "completed",
    },
    { type: "system.notice", id: "notice-1", text: "note", level: "info" },
    {
      type: "tool",
      id: "tool-2",
      tool: "Read",
      output: "two",
      status: "completed",
    },
  ];

  const sections = groupTimelineRows(rows);
  assert.equal(sections.length, 3);
  assert.equal(sections[0]?.type, "tool-group");
  assert.equal(sections[2]?.type, "tool-group");
});

test("replaces started tool details with the completed provider item", () => {
  const started = applyTimelineEvent([], {
    type: "tool.started",
    id: "command-1",
    tool: "command",
    input: { command: "pwd", cwd: "/work" },
    details: {
      type: "commandExecution",
      status: "inProgress",
      exitCode: null,
    },
  });
  const completed = applyTimelineEvent(started, {
    type: "tool.completed",
    id: "command-1",
    status: "completed",
    output: "/work\n",
    details: {
      type: "commandExecution",
      status: "completed",
      exitCode: 0,
      durationMs: 12,
    },
  });

  assert(completed[0]?.type === "tool");
  assert.deepEqual(completed[0].details, {
    type: "commandExecution",
    status: "completed",
    exitCode: 0,
    durationMs: 12,
  });
});

test("merges a subagent lifecycle and streaming output into one agent timeline", () => {
  let rows = applyTimelineEvent([], {
    type: "subagent.started",
    id: "started",
    agentId: "agent-1",
    name: "Turing",
    agentPath: "/root/reviewer",
    cwd: "/work/project",
    role: "reviewer",
  });
  rows = applyTimelineEvent(rows, {
    type: "subagent.event",
    id: "partial-message-1",
    agentId: "agent-1",
    event: {
      type: "assistant.message",
      id: "message-1",
      text: "Reviewing",
      partial: true,
    },
  });
  rows = applyTimelineEvent(rows, {
    type: "subagent.event",
    id: "completed-message-1",
    agentId: "agent-1",
    event: {
      type: "assistant.message",
      id: "message-1",
      text: "Review complete",
    },
  });
  rows = applyTimelineEvent(rows, {
    type: "subagent.state",
    id: "completed",
    agentId: "agent-1",
    state: "completed",
  });

  assert.deepEqual(rows, [
    {
      type: "subagent",
      id: "subagent:agent-1",
      agentId: "agent-1",
      name: "Turing",
      agentPath: "/root/reviewer",
      cwd: "/work/project",
      role: "reviewer",
      state: "completed",
      activities: [{ id: "completed", state: "completed" }],
      timeline: [
        {
          type: "assistant.message",
          id: "message-1",
          text: "Review complete",
        },
      ],
    },
  ]);
});

test("finds tools inside a subagent timeline", () => {
  const childTool = {
    type: "tool" as const,
    id: "agent-1:command-1",
    tool: "command",
    output: "/work\n",
    status: "completed" as const,
  };
  const rows: TimelineRow[] = [
    {
      type: "subagent",
      id: "subagent:agent-1",
      agentId: "agent-1",
      state: "completed",
      activities: [],
      timeline: [childTool],
    },
  ];

  assert.equal(findTimelineTool(rows, childTool.id), childTool);
  assert.equal(findTimelineTool(rows, "missing"), undefined);
});

test("updates main and child rows in place without mutating earlier timeline snapshots", () => {
  const original: TimelineRow[] = [
    { type: "assistant.message", id: "main", text: "before" },
    {
      type: "subagent",
      id: "subagent:child",
      agentId: "child",
      state: "running",
      activities: [],
      timeline: [
        { type: "assistant.message", id: "child-message", text: "before" },
      ],
    },
  ];
  const mainUpdated = applyTimelineEvent(original, {
    type: "assistant.message",
    id: "main",
    text: "after",
  });
  const childUpdated = applyTimelineEvent(mainUpdated, {
    type: "subagent.event",
    id: "event",
    agentId: "child",
    event: { type: "assistant.message", id: "child-message", text: "after" },
  });
  assert.deepEqual(
    childUpdated.map((row) => row.id),
    ["main", "subagent:child"],
  );
  assert(original[0]?.type === "assistant.message");
  assert.equal(original[0].text, "before");
  assert(mainUpdated[1]?.type === "subagent");
  assert.deepEqual(mainUpdated[1].timeline, [
    { type: "assistant.message", id: "child-message", text: "before" },
  ]);
  assert(childUpdated[1]?.type === "subagent");
  assert.deepEqual(childUpdated[1].timeline, [
    { type: "assistant.message", id: "child-message", text: "after" },
  ]);
});
