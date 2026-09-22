import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type {
  SDKTaskStartedMessage,
  SDKTaskProgressMessage,
  SDKTaskNotificationMessage,
  SDKToolProgressMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentInput,
  AgentOutput,
  TaskStopOutput,
} from "@anthropic-ai/claude-agent-sdk/sdk-tools";
import type { ToolCompletionStatus } from "../../../shared/protocol.js";
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
const heartbeat = (
  callId: string | null,
  elapsed: number,
): SDKToolProgressMessage => ({
  type: "tool_progress",
  tool_use_id: `opaque-pulse-${randomUUID()}`,
  tool_name: "Bash",
  parent_tool_use_id: callId,
  elapsed_time_seconds: elapsed,
  heartbeat: true,
  uuid: randomUUID(),
  session_id,
});

function stopEvents(
  tracker: ClaudeActivityTracker,
  output: TaskStopOutput,
  status: ToolCompletionStatus = "completed",
  parentToolUseId: string | null = null,
  inputTarget = output.task_id,
) {
  const id = `stop-${randomUUID()}`;
  return [
    ...tracker.observe(
      [
        {
          type: "tool.started",
          id,
          tool: "TaskStop",
          input: { task_id: inputTarget },
        },
      ],
      parentToolUseId,
    ),
    ...tracker.observe(
      [
        {
          type: "tool.completed",
          id,
          status,
          output: output.message,
          details: { type: "claudeToolResult", result: output },
        },
      ],
      parentToolUseId,
    ),
  ];
}

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
          id: "bash-1",
          tool: "Bash",
          input: { command: "cat app.ts" },
        },
      ],
      "spawn",
    ),
  );
  events.push(
    ...tracker.map({
      type: "tool_progress",
      tool_use_id: "bash-progress-0",
      tool_name: "Bash",
      parent_tool_use_id: "bash-1",
      elapsed_time_seconds: 8,
      uuid: randomUUID(),
      session_id,
    })!,
  );
  events.push(
    ...tracker.map({
      type: "tool_use_summary",
      preceding_tool_use_ids: ["bash-1"],
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

for (const owner of ["main", "child"] as const) {
  test(`native heartbeats update the existing ${owner} call without creating pulse tools`, () => {
    const tracker = new ClaudeActivityTracker();
    const events =
      owner === "child" ? tracker.map(started("agent-1", "spawn"))! : [];
    events.push(
      ...tracker.observe(
        [
          {
            type: "tool.started",
            id: "bash-call",
            tool: "Bash",
            input: { command: "sleep 30" },
          },
        ],
        owner === "child" ? "spawn" : null,
      ),
    );
    events.push(...tracker.map(heartbeat("bash-call", 9))!);
    assert.deepEqual(
      tracker.map(heartbeat("bash-call", 3)),
      [],
      "out-of-order elapsed observations must not move backward",
    );
    events.push(
      ...tracker.observe(
        [
          {
            type: "tool.completed",
            id: "bash-call",
            status: "completed",
            output: "done",
          },
        ],
        owner === "child" ? "spawn" : null,
      ),
    );
    assert.deepEqual(
      tracker.map(heartbeat("bash-call", 20)),
      [],
      "late heartbeats cannot change a settled call",
    );
    if (owner === "child") events.push(...tracker.map(finished("agent-1"))!);
    assert.deepEqual(tracker.finish("incomplete"), []);
    const rows = buildTimeline(events);
    const tools =
      owner === "child" && rows[0]?.type === "subagent"
        ? rows[0].timeline
        : rows;
    assert.equal(tools.length, 1);
    const [tool] = tools;
    assert(tool?.type === "tool");
    assert.equal(tool.id, "bash-call");
    assert.equal(tool.status, "completed");
    assert.equal(tool.progress?.elapsedSeconds, 9);
    assert.equal(tool.output, "done");
  });
}

test("retains only the latest early elapsed observation until its actual call arrives", () => {
  const tracker = new ClaudeActivityTracker();
  for (const elapsed of [2, 8, 4])
    assert.deepEqual(tracker.map(heartbeat("later-call", elapsed)), []);
  const events = tracker.observe(
    [
      {
        type: "tool.started",
        id: "later-call",
        tool: "Bash",
        input: { command: "sleep 30" },
      },
    ],
    null,
  );
  assert.deepEqual(events, [
    {
      type: "tool.started",
      id: "later-call",
      tool: "Bash",
      input: { command: "sleep 30" },
    },
    { type: "tool.progress", id: "later-call", elapsedSeconds: 8 },
  ]);
  events.push(...tracker.finish("interrupted"));
  assert.deepEqual(tracker.map(heartbeat("later-call", 10)), []);
  const [tool] = buildTimeline(events);
  assert(tool?.type === "tool");
  assert.equal(tool.status, "interrupted");
  assert.equal(tool.progress?.elapsedSeconds, 8);
});

test("uncorrelated and result-before-start heartbeats never create tools or child warnings", () => {
  const tracker = new ClaudeActivityTracker();
  assert.deepEqual(tracker.map(heartbeat("never-observed", 6)), []);
  assert.deepEqual(tracker.map(heartbeat(null, 7)), []);
  tracker.observe(
    [{ type: "tool.completed", id: "already-done", status: "completed" }],
    null,
  );
  assert.deepEqual(tracker.map(heartbeat("already-done", 8)), []);
  const replay = tracker.observe(
    [{ type: "tool.started", id: "already-done", tool: "Bash", input: {} }],
    null,
  );
  assert.equal(replay.length, 1);
  assert.deepEqual(tracker.finish("incomplete"), []);
});

test("native Agent retries use the parent call's nested owner and never report zero elapsed time", () => {
  const tracker = new ClaudeActivityTracker();
  const retry: SDKToolProgressMessage = {
    type: "tool_progress",
    tool_use_id: "agent_api-message",
    tool_name: "Agent",
    parent_tool_use_id: "nested-spawn",
    elapsed_time_seconds: 0,
    subagent_retry: {
      agent_id: "nested-agent",
      attempt: 2,
      max_retries: 4,
      retry_delay_ms: 1000,
      error_status: 429,
      error_category: "rate_limit",
    },
    uuid: randomUUID(),
    session_id,
  };
  assert.deepEqual(tracker.map(retry), []);
  const events = tracker.map(started("parent-agent", "parent-spawn"))!;
  events.push(
    ...tracker.observe(
      [
        {
          type: "tool.started",
          id: "nested-spawn",
          tool: "Agent",
          input: { prompt: "Inspect parser" },
        },
      ],
      "parent-spawn",
    ),
  );
  const { subagent_retry: _retry, ...resolved } = retry;
  assert.deepEqual(tracker.map({ ...resolved, uuid: randomUUID() }), []);
  const [parent] = buildTimeline(events);
  assert(parent?.type === "subagent");
  assert.equal(parent.timeline.length, 2);
  const tool = parent.timeline[0];
  assert(tool?.type === "tool");
  assert.equal(tool.id, "nested-spawn");
  assert.equal(tool.progress, undefined);
  const notice = parent.timeline[1];
  assert(notice?.type === "system.notice");
  assert.match(notice.text, /重试 2\/4.*rate_limit.*1000 ms/);
});

for (const bashFirst of [true, false]) {
  test(`early forwarded Bash progress ${bashFirst ? "before" : "after"} Agent retry cannot contaminate or discard the matching source`, () => {
    const tracker = new ClaudeActivityTracker();
    const bash: SDKToolProgressMessage = {
      type: "tool_progress",
      tool_use_id: "bash-progress-0",
      tool_name: "Bash",
      parent_tool_use_id: "spawn",
      elapsed_time_seconds: 12,
      uuid: randomUUID(),
      session_id,
    };
    const retry: SDKToolProgressMessage = {
      type: "tool_progress",
      tool_use_id: "agent_message",
      tool_name: "Agent",
      parent_tool_use_id: "spawn",
      elapsed_time_seconds: 0,
      subagent_retry: {
        agent_id: "worker",
        attempt: 1,
        max_retries: 3,
        retry_delay_ms: 1000,
        error_status: 429,
        error_category: "rate_limit",
      },
      uuid: randomUUID(),
      session_id,
    };
    for (const message of bashFirst ? [bash, retry] : [retry, bash])
      assert.deepEqual(tracker.map(message), []);
    const events = tracker.observe(
      [
        {
          type: "tool.started",
          id: "spawn",
          tool: "Agent",
          input: { prompt: "Run checks" },
        },
      ],
      null,
    );
    const rows = buildTimeline(events);
    const call = rows.find((row) => row.type === "tool");
    assert(call?.type === "tool");
    assert.equal(call.id, "spawn");
    assert.equal(call.progress, undefined);
    assert(
      rows.some(
        (row) => row.type === "system.notice" && row.text.includes("重试 1/3"),
      ),
    );
    assert.deepEqual(
      tracker.map({ ...bash, elapsed_time_seconds: 20, uuid: randomUUID() }),
      [],
    );
    assert(
      !tracker
        .finish("incomplete")
        .some((event) => event.type === "system.notice"),
    );
  });
}

test("early measurements retain separate tool sources until the actual call establishes a match", () => {
  const tracker = new ClaudeActivityTracker();
  assert.deepEqual(tracker.map(heartbeat("read-call", 99)), []);
  assert.deepEqual(
    tracker.map({ ...heartbeat("read-call", 4), tool_name: "Read" }),
    [],
  );
  assert.deepEqual(tracker.map(heartbeat("read-call", 100)), []);
  const events = tracker.observe(
    [
      {
        type: "tool.started",
        id: "read-call",
        tool: "Read",
        input: { file_path: "app.ts" },
      },
    ],
    null,
  );
  const [call] = buildTimeline(events);
  assert(call?.type === "tool");
  assert.equal(call.progress?.elapsedSeconds, 4);
  assert.deepEqual(tracker.map(heartbeat("read-call", 101)), []);
  assert.deepEqual(
    tracker.map({ ...heartbeat("read-call", 6), tool_name: "Read" }),
    [{ type: "tool.progress", id: "read-call", elapsedSeconds: 6 }],
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
  assert.deepEqual(
    tracker.map({ ...heartbeat("read-1", 20), tool_name: "Read" }),
    [],
  );
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

test("successful TaskStop targets the canonical result ID and leaves its caller and same-named peers running", () => {
  const tracker = new ClaudeActivityTracker();
  const events = [
    ...tracker.map(started("parent", "parent-spawn"))!,
    ...tracker.map(started("target", "target-spawn"))!,
    ...tracker.map(started("peer", "peer-spawn"))!,
  ];
  for (const agent of ["parent", "target", "peer"])
    events.push(
      ...tracker.observe(
        [
          {
            type: "tool.started",
            id: `${agent}-read`,
            tool: "Read",
            input: {},
          },
        ],
        `${agent}-spawn`,
      ),
    );
  events.push(
    ...stopEvents(
      tracker,
      {
        task_id: "target",
        task_type: "local_agent",
        message: "Successfully stopped target",
      },
      "completed",
      "parent-spawn",
      "Read parser",
    ),
  );
  const rows = buildTimeline(events);
  for (const id of ["parent", "target", "peer"]) {
    const agent = rows.find(
      (row) => row.type === "subagent" && row.agentId === id,
    );
    assert(agent?.type === "subagent");
    assert.equal(agent.state, id === "target" ? "interrupted" : "running");
    const tool = agent.timeline.find((row) => row.id === `${id}-read`);
    assert(tool?.type === "tool");
    assert.equal(tool.status, id === "target" ? "interrupted" : "running");
  }
  assert.deepEqual(tracker.map(progress("target", "target-spawn")), []);
});

for (const status of ["failed", "interrupted", "incomplete"] as const) {
  test(`a ${status} TaskStop cannot change an explicitly completed task`, () => {
    const tracker = new ClaudeActivityTracker();
    const events = tracker.map(started("done", "spawn"))!;
    events.push(...tracker.map(finished("done"))!);
    events.push(
      ...stopEvents(
        tracker,
        {
          task_id: "done",
          task_type: "local_agent",
          message: "Task cannot be stopped",
        },
        status,
      ),
    );
    events.push(...tracker.finish("incomplete"));
    const agent = buildTimeline(events).find((row) => row.type === "subagent");
    assert(agent?.type === "subagent");
    assert.equal(agent.state, "completed");
    assert.equal(agent.statusMessage, "Parser checked");
  });
}

test("successful TaskStop preserves a known background task's actual owner", () => {
  const tracker = new ClaudeActivityTracker();
  const events = tracker.map(started("owner", "spawn"))!;
  events.push(
    ...tracker.observe(
      [
        {
          type: "tool.started",
          id: "bash-call",
          tool: "Bash",
          input: { command: "sleep 30" },
        },
      ],
      "spawn",
    ),
  );
  events.push(
    ...tracker.map(started("background", "bash-call", "local_bash"))!,
  );
  events.push(
    ...tracker.observe(
      [
        {
          type: "tool.completed",
          id: "bash-call",
          status: "completed",
          output: "Launched",
        },
      ],
      "spawn",
    ),
  );
  events.push(
    ...stopEvents(tracker, {
      task_id: "background",
      task_type: "local_bash",
      message: "Background command stopped",
    }),
  );
  const rows = buildTimeline(events);
  const owner = rows.find((row) => row.type === "subagent");
  assert(owner?.type === "subagent");
  assert.equal(owner.state, "running");
  const task = owner.timeline.find(
    (row) => row.id === "claude-task:background",
  );
  assert(task?.type === "tool");
  assert.equal(task.status, "interrupted");
  const launch = owner.timeline.find((row) => row.id === "bash-call");
  assert(launch?.type === "tool");
  assert.equal(launch.status, "completed");
  assert(!rows.some((row) => row.id === "claude-task:background"));
});

for (const taskType of ["local_agent", "local_bash"]) {
  test(`a successful stop restores an unrecorded ${taskType} target without inventing launch metadata`, () => {
    const tracker = new ClaudeActivityTracker();
    const events = stopEvents(tracker, {
      task_id: "missing-launch",
      task_type: taskType,
      message: "Stopped task",
    });
    events.push(...tracker.finish("incomplete"));
    const rows = buildTimeline(events);
    if (taskType === "local_agent") {
      const target = rows.find((row) => row.type === "subagent");
      assert(target?.type === "subagent");
      assert.equal(target.agentId, "missing-launch");
      assert.equal(target.state, "interrupted");
      for (const key of [
        "name",
        "prompt",
        "role",
        "model",
        "cwd",
        "parentAgentId",
      ] as const)
        assert.equal(target[key], undefined);
    } else {
      assert(!rows.some((row) => row.type === "subagent"));
      const target = rows.find(
        (row) => row.id === "claude-task:missing-launch",
      );
      assert(target?.type === "tool");
      assert.equal(target.tool, "backgroundTask");
      assert.equal(target.status, "interrupted");
      assert.equal(target.input, undefined);
    }
  });
}

test("an unsuccessful stop without a launch record does not invent a target", () => {
  const tracker = new ClaudeActivityTracker();
  const events = stopEvents(
    tracker,
    { task_id: "missing", task_type: "local_agent", message: "No such task" },
    "failed",
  );
  events.push(...tracker.finish("incomplete"));
  const rows = buildTimeline(events);
  assert.equal(rows.length, 1);
  assert(rows[0]?.type === "tool" && rows[0].tool === "TaskStop");
});

test("an old Agent receipt cannot undo TaskStop but a native SendMessage task start can", () => {
  const tracker = new ClaudeActivityTracker();
  const events = tracker.observe(
    [
      {
        type: "tool.started",
        id: "spawn",
        tool: "Agent",
        input: {
          description: "Check parser",
          prompt: "Check parser",
        } satisfies AgentInput,
      },
    ],
    null,
  );
  const launched = {
    type: "tool.completed" as const,
    id: "spawn",
    status: "completed" as const,
    details: {
      type: "claudeToolResult",
      result: {
        status: "async_launched",
        agentId: "worker",
        description: "Check parser",
        prompt: "Check parser",
        outputFile: "/work/worker.txt",
      } satisfies AgentOutput,
    },
  };
  events.push(...tracker.observe([launched], null));
  const stoppedEvents = stopEvents(tracker, {
    task_id: "worker",
    task_type: "local_agent",
    message: "Stopped worker",
  });
  events.push(...stoppedEvents);
  events.push(...tracker.observe([launched], null));
  const stopped = buildTimeline(events).find((row) => row.type === "subagent");
  assert(stopped?.type === "subagent");
  assert.equal(stopped.state, "interrupted");
  events.push(
    ...tracker.observe(
      [
        {
          type: "tool.started",
          id: "send-call",
          tool: "SendMessage",
          input: { to: "worker", message: "Continue" },
        },
      ],
      null,
    ),
  );
  const beforeStart = buildTimeline(events).find(
    (row) => row.type === "subagent",
  );
  assert(beforeStart?.type === "subagent");
  assert.equal(beforeStart.state, "interrupted");
  events.push(...tracker.map(started("worker", "send-call"))!);
  const resumed = buildTimeline(events).find((row) => row.type === "subagent");
  assert(resumed?.type === "subagent");
  assert.equal(resumed.state, "running");
  const oldStop = stoppedEvents.at(-1);
  assert(oldStop?.type === "tool.completed");
  events.push(...tracker.observe([oldStop], null));
  const afterReplay = buildTimeline(events).find(
    (row) => row.type === "subagent",
  );
  assert(afterReplay?.type === "subagent");
  assert.equal(afterReplay.state, "running");
});

test("a native task_started can reopen a stopped agent whose old launch identity is unavailable", () => {
  const tracker = new ClaudeActivityTracker();
  const events = stopEvents(tracker, {
    task_id: "worker",
    task_type: "local_agent",
    message: "Stopped worker",
  });
  events.push(...tracker.map(started("worker", "send-call"))!);
  const worker = buildTimeline(events).find((row) => row.type === "subagent");
  assert(worker?.type === "subagent");
  assert.equal(worker.state, "running");
});

test("a successful result without TaskStop provenance or complete target identity cannot stop a task", () => {
  for (const [toolName, output] of [
    ["Read", { task_id: "worker", task_type: "local_agent" }],
    ["TaskStop", { task_id: "worker" }],
    ["TaskStop", { task_type: "local_agent" }],
  ] as const) {
    const tracker = new ClaudeActivityTracker();
    const events = tracker.map(started("worker", "spawn"))!;
    events.push(
      ...tracker.observe(
        [
          { type: "tool.started", id: "call", tool: toolName, input: {} },
          {
            type: "tool.completed",
            id: "call",
            status: "completed",
            details: { type: "claudeToolResult", result: output },
          },
        ],
        null,
      ),
    );
    const worker = buildTimeline(events).find((row) => row.type === "subagent");
    assert(worker?.type === "subagent");
    assert.equal(worker.state, "running");
  }
});
