import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type {
  SDKTaskStartedMessage,
  SDKTaskProgressMessage,
  SDKTaskNotificationMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { buildTimeline } from "../../../web/store.js";
import { ClaudeActivityTracker } from "./activity-tracker.js";

const session_id = randomUUID();
const started = (
  task_id: string,
  tool_use_id: string,
  task_type = "local_agent",
): SDKTaskStartedMessage => ({
  type: "system",
  subtype: "task_started",
  task_id,
  tool_use_id,
  task_type,
  description: "Read parser",
  uuid: randomUUID(),
  session_id,
});
const progress = (
  task_id: string,
  tool_use_id: string,
): SDKTaskProgressMessage => ({
  type: "system",
  subtype: "task_progress",
  task_id,
  tool_use_id,
  description: "Read parser",
  summary: "Found the entry point",
  last_tool_name: "Read",
  usage: { total_tokens: 321, tool_uses: 2, duration_ms: 4500 },
  uuid: randomUUID(),
  session_id,
});
const finished = (
  task_id: string,
  status: SDKTaskNotificationMessage["status"] = "completed",
): SDKTaskNotificationMessage => ({
  type: "system",
  subtype: "task_notification",
  task_id,
  status,
  summary: "Parser checked",
  output_file: "/work/task-output.txt",
  uuid: randomUUID(),
  session_id,
});

test("holds early child messages until a native task identity is known", () => {
  const tracker = new ClaudeActivityTracker();
  const events = tracker.observe(
    [
      {
        type: "tool.started",
        id: "spawn",
        tool: "Agent",
        input: {
          description: "Read parser",
          prompt: "Check parser",
          model: "sonnet",
        },
      },
    ],
    null,
  );
  assert.deepEqual(
    tracker.observe(
      [
        {
          type: "assistant.message",
          id: "child-text",
          text: "Child-only reply",
        },
      ],
      "spawn",
    ),
    [],
  );
  events.push(...tracker.map(started("native-agent", "spawn"))!);
  const rows = buildTimeline(events);
  assert(!rows.some((row) => row.type === "assistant.message"));
  const child = rows.find((row) => row.type === "subagent");
  assert(child?.type === "subagent");
  assert.equal(child.agentId, "native-agent");
  assert.equal(
    child.cwd,
    undefined,
    "live task start does not invent a directory",
  );
  assert.equal(child.prompt, "Check parser");
  assert.equal(child.model, "sonnet");
  assert.deepEqual(child.timeline, [
    { type: "assistant.message", id: "child-text", text: "Child-only reply" },
  ]);
});

test("keeps Bash background tasks out of the subagent catalog", () => {
  const tracker = new ClaudeActivityTracker();
  const events = tracker.map(started("bash-task", "bash-call", "local_bash"))!;
  events.push(
    ...tracker.map(progress("bash-task", "bash-call"))!,
    ...tracker.map(finished("bash-task", "failed"))!,
  );
  const [task] = buildTimeline(events);
  assert(task?.type === "tool");
  assert.equal(task.tool, "backgroundTask");
  assert.equal(task.status, "failed");
  assert.equal(task.progress?.elapsedSeconds, 4.5);
  assert.equal(task.output, "Parser checked");
  assert(!events.some((event) => event.type.startsWith("subagent.")));
});

test("routes tool progress and native summaries to their child without fabricating stdout", () => {
  const tracker = new ClaudeActivityTracker();
  const events = tracker.map(started("agent-1", "spawn"))!;
  events.push(
    ...tracker.observe(
      [
        {
          type: "tool.started",
          id: "read-1",
          tool: "Read",
          input: { file_path: "app.ts" },
        },
      ],
      "spawn",
    ),
  );
  events.push(
    ...tracker.map({
      type: "tool_progress",
      tool_use_id: "read-1",
      tool_name: "Read",
      parent_tool_use_id: "spawn",
      elapsed_time_seconds: 8,
      uuid: randomUUID(),
      session_id,
    })!,
  );
  events.push(
    ...tracker.map({
      type: "tool_use_summary",
      preceding_tool_use_ids: ["read-1"],
      summary: "Inspected parser inputs",
      uuid: randomUUID(),
      session_id,
    })!,
  );
  const [child] = buildTimeline(events);
  assert(child?.type === "subagent");
  const tool = child.timeline.find((row) => row.type === "tool");
  assert(tool?.type === "tool");
  assert.equal(tool.progress?.elapsedSeconds, 8);
  assert.equal(tool.output, "");
  assert(
    child.timeline.some(
      (row) =>
        row.type === "system.notice" && row.text === "Inspected parser inputs",
    ),
  );
});

test("task terminal events close only the owning child's pending tools", () => {
  const tracker = new ClaudeActivityTracker();
  const events = [
    ...tracker.map(started("agent-1", "spawn-1"))!,
    ...tracker.map(started("agent-2", "spawn-2"))!,
  ];
  events.push(
    ...tracker.observe(
      [{ type: "tool.started", id: "read-1", tool: "Read", input: {} }],
      "spawn-1",
    ),
  );
  events.push(
    ...tracker.observe(
      [{ type: "tool.started", id: "read-2", tool: "Read", input: {} }],
      "spawn-2",
    ),
  );
  events.push(...tracker.map(finished("agent-1", "stopped"))!);
  const rows = buildTimeline(events);
  const first = rows.find(
    (row) => row.type === "subagent" && row.agentId === "agent-1",
  );
  const second = rows.find(
    (row) => row.type === "subagent" && row.agentId === "agent-2",
  );
  assert(first?.type === "subagent" && second?.type === "subagent");
  assert.equal(first.state, "interrupted");
  assert.equal(
    first.timeline[0]?.type === "tool" && first.timeline[0].status,
    "interrupted",
  );
  assert.equal(
    second.timeline[0]?.type === "tool" && second.timeline[0].status,
    "running",
  );
  assert.deepEqual(tracker.map(progress("agent-1", "spawn-1")), []);
});

test("query end retains latest progress and marks unconfirmed child state unknown", () => {
  const tracker = new ClaudeActivityTracker();
  const events = tracker.map(started("agent-1", "spawn-1"))!;
  events.push(...tracker.map(progress("agent-1", "spawn-1"))!);
  events.push(
    ...tracker.observe(
      [{ type: "tool.started", id: "read-1", tool: "Read", input: {} }],
      "spawn-1",
    ),
  );
  events.push(...tracker.finish("incomplete"));
  const [child] = buildTimeline(events);
  assert(child?.type === "subagent");
  assert.equal(child.state, "unknown");
  assert.match(child.statusMessage!, /Found the entry point.*未收到子任务终态/);
  assert.equal(
    child.timeline[0]?.type === "tool" && child.timeline[0].status,
    "incomplete",
  );
  assert.deepEqual(tracker.finish("incomplete"), []);
});

test("late parent identity repairs nested lineage while native completion stays completed", () => {
  const tracker = new ClaudeActivityTracker();
  const events = tracker.observe(
    [{ type: "tool.started", id: "nested-spawn", tool: "Agent", input: {} }],
    "parent-spawn",
  );
  events.push(...tracker.map(started("nested-agent", "nested-spawn"))!);
  events.push(...tracker.map(started("parent-agent", "parent-spawn"))!);
  events.push(
    ...tracker.observe(
      [
        {
          type: "tool.completed",
          id: "nested-spawn",
          status: "completed",
          details: {
            type: "claudeToolResult",
            result: {
              agentId: "nested-agent",
              status: "completed",
              worktreePath: "/work/nested-agent",
              content: [{ type: "text", text: "Nested result" }],
            },
          },
        },
      ],
      "parent-spawn",
    ),
  );
  events.push(...tracker.finish("incomplete"));
  const child = buildTimeline(events).find(
    (row) => row.type === "subagent" && row.agentId === "nested-agent",
  );
  assert(child?.type === "subagent");
  assert.equal(child.parentAgentId, "parent-agent");
  assert.equal(child.state, "completed");
  assert.equal(child.statusMessage, "Nested result");
  assert.equal(child.cwd, "/work/nested-agent");
});

test("hides housekeeping tasks and preserves unknown task notifications as generic tasks", () => {
  const tracker = new ClaudeActivityTracker();
  assert.deepEqual(
    tracker.map({
      ...started("watcher", "watch", "local_bash"),
      ambient: true,
    }),
    [],
  );
  assert.deepEqual(tracker.map(progress("watcher", "watch")), []);
  assert.deepEqual(tracker.map(finished("unannounced")), []);
  const events = tracker.finish("incomplete");
  assert(!events.some((event) => event.type.startsWith("subagent.")));
  const [task] = buildTimeline(events);
  assert(task?.type === "tool");
  assert.equal(task.id, "claude-task:unannounced");
  assert.equal(task.status, "completed");
});
