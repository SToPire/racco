import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type {
  SDKAssistantMessage,
  SDKPartialAssistantMessage,
  SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { buildTimeline } from "../../../web/store.js";
import { buildTrajectory } from "../../../web/trajectory.js";
import { ClaudeLiveMapper, mapClaudeHistory } from "./event-mapper.js";

const messages: SessionMessage[] = [
  {
    type: "user",
    uuid: "user-1",
    session_id: "session-1",
    parent_tool_use_id: null,
    parent_agent_id: null,
    message: { role: "user", content: "inspect package.json" },
  },
  {
    type: "assistant",
    uuid: "assistant-tool",
    session_id: "session-1",
    parent_tool_use_id: null,
    parent_agent_id: null,
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "tool-1",
          name: "Read",
          input: { file_path: "package.json" },
        },
      ],
    },
  },
  {
    type: "user",
    uuid: "tool-result",
    session_id: "session-1",
    parent_tool_use_id: null,
    parent_agent_id: null,
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: '{"name":"racco"}',
        },
      ],
    },
  },
  {
    type: "assistant",
    uuid: "assistant-text",
    session_id: "session-1",
    parent_tool_use_id: null,
    parent_agent_id: null,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
    },
  },
];

test("maps Claude history into the shared materialized timeline", () => {
  assert.deepEqual(buildTimeline(mapClaudeHistory(messages)), [
    {
      type: "user.message",
      id: "user-1",
      text: "inspect package.json",
    },
    {
      type: "tool",
      id: "tool-1",
      tool: "Read",
      input: { file_path: "package.json" },
      output: '{"name":"racco"}',
      status: "completed",
      details: { type: "claudeToolResult", content: '{"name":"racco"}' },
    },
    {
      type: "assistant.message",
      id: "assistant-text:text:0",
      text: "done",
    },
  ]);
});

test("live task notifications suppress user text but retain child tool results", () => {
  const mapper = new ClaudeLiveMapper();
  const events = mapper.map({
    type: "system",
    subtype: "task_started",
    task_id: "child",
    tool_use_id: "spawn",
    task_type: "local_agent",
    description: "Child task",
    uuid: randomUUID(),
    session_id: "session-1",
  });
  for (const origin of [
    undefined,
    { kind: "human" } as const,
    { kind: "task-notification" } as const,
    { kind: "task-notification", subkind: "scheduled-trigger" } as const,
    { kind: "task-notification", subkind: "peer-send-message" } as const,
    { kind: "task-notification", subkind: "projects-relay" } as const,
  ]) {
    events.push(
      ...mapper.map({
        type: "user",
        uuid: randomUUID(),
        session_id: "session-1",
        parent_tool_use_id: "spawn",
        ...(origin === undefined ? {} : { origin }),
        message: {
          role: "user",
          content: "<task-notification>example</task-notification>",
        },
      }),
    );
  }
  events.push(
    ...mapper.map({
      type: "user",
      uuid: randomUUID(),
      session_id: "session-1",
      parent_tool_use_id: "spawn",
      origin: { kind: "task-notification" },
      tool_use_result: { stdout: "done" },
      message: {
        role: "user",
        content: [
          { type: "text", text: "Background task finished" },
          { type: "tool_result", tool_use_id: "child-tool", content: "done" },
        ],
      },
    }),
  );
  const childEvents = events.flatMap((event) =>
    event.type === "subagent.event" ? [event.event] : [],
  );
  assert.equal(
    childEvents.filter((event) => event.type === "user.message").length,
    5,
  );
  assert(
    childEvents.some(
      (event) => event.type === "tool.completed" && event.output === "done",
    ),
  );
});

for (const content of ["Model-facing summary", undefined]) {
  test(`keeps native results separate from ${content === undefined ? "absent" : "present"} model output`, () => {
    const result = {
      stdout: "partial stdout",
      stderr: "cancelled",
      interrupted: true,
      backgroundTaskId: "task-1",
    };
    const [event] = new ClaudeLiveMapper().map({
      type: "user",
      parent_tool_use_id: null,
      tool_use_result: result,
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "bash-1",
            ...(content === undefined ? {} : { content }),
            is_error: true,
          },
        ],
      },
    });
    assert.deepEqual(event, {
      type: "tool.completed",
      id: "bash-1",
      status: "interrupted",
      output: content ?? "",
      details: {
        type: "claudeToolResult",
        result,
        content,
      },
    });
  });
}

test("preserves attachment blocks without putting base64 data into display text", () => {
  const content = [
    { type: "text" as const, text: "Screenshot" },
    {
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: "image/png" as const,
        data: "cGljdHVyZQ==",
      },
    },
  ];
  const [event] = new ClaudeLiveMapper().map({
    type: "user",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "image-1", content }],
    },
  });
  assert.deepEqual(event, {
    type: "tool.completed",
    id: "image-1",
    status: "completed",
    output: "Screenshot",
    details: { type: "claudeToolResult", content },
  });
});

test("does not attribute one structured result to multiple tool results", () => {
  assert.throws(
    () =>
      new ClaudeLiveMapper().map({
        type: "user",
        parent_tool_use_id: null,
        tool_use_result: { stdout: "one" },
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "one", content: "one" },
            { type: "tool_result", tool_use_id: "two", content: "two" },
          ],
        },
      }),
    /Ambiguous Claude structured tool result/,
  );
});

test("rejects incomplete Claude tool identifiers instead of inventing timeline rows", () => {
  const base = messages[1]!;
  for (const block of [
    { type: "tool_use", name: "Read", input: {} },
    { type: "tool_use", id: "tool-1", input: {} },
  ]) {
    assert.throws(
      () =>
        mapClaudeHistory([
          { ...base, message: { role: "assistant", content: [block] } },
        ]),
      /Invalid Claude tool field/,
    );
  }
  assert.throws(
    () =>
      new ClaudeLiveMapper().map({
        type: "user",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [{ type: "tool_result", content: "done" }],
        },
      } as Parameters<ClaudeLiveMapper["map"]>[0]),
    /Invalid Claude tool field/,
  );
});

test("hides only Claude's synthetic no-response placeholder", () => {
  function history(model: string, text: string) {
    return mapClaudeHistory([
      {
        ...messages[3]!,
        message: {
          model,
          role: "assistant",
          content: [{ type: "text", text }],
        },
      },
    ]);
  }
  assert.deepEqual(history("<synthetic>", "No response requested."), []);
  assert.equal(history("real-model", "No response requested.").length, 1);
  assert.equal(history("<synthetic>", "A useful command response").length, 1);
});

test("routes complete live child messages and results through task identity", () => {
  const mapper = new ClaudeLiveMapper();
  const events = mapper.map({
    type: "system",
    subtype: "task_started",
    task_id: "native-agent",
    tool_use_id: "spawn",
    task_type: "local_agent",
    description: "Check cache",
    prompt: "Inspect cache implementation",
    uuid: randomUUID(),
    session_id: "session-1",
  });
  events.push(
    ...mapper.map(
      assistantBlock(
        "child-complete",
        "child-api",
        [
          { type: "text", text: "Cache checked", citations: [] },
          {
            type: "tool_use",
            id: "child-tool",
            name: "Read",
            input: { file_path: "cache.ts" },
          },
        ],
        "spawn",
      ),
    ),
  );
  events.push(
    ...mapper.map({
      type: "user",
      parent_tool_use_id: "spawn",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "child-tool",
            content: "cache source",
          },
        ],
      },
    }),
  );
  events.push(
    ...mapper.map({
      type: "system",
      subtype: "task_notification",
      task_id: "native-agent",
      status: "completed",
      summary: "No cache bug found",
      output_file: "/work/task-output.txt",
      uuid: randomUUID(),
      session_id: "session-1",
    }),
  );
  events.push(...mapper.finish("completed"));
  const rows = buildTimeline(events);
  assert.equal(rows.length, 1);
  const [child] = rows;
  assert(child?.type === "subagent");
  assert.equal(child.state, "completed");
  assert.equal(child.statusMessage, "No cache bug found");
  assert.equal(child.timeline[0]?.type, "assistant.message");
  assert.equal(
    child.timeline[1]?.type === "tool" && child.timeline[1].status,
    "completed",
  );
});

test("maps the SDK heartbeat pulse to the actual Bash call and finishes without a false child warning", () => {
  const mapper = new ClaudeLiveMapper();
  const events = mapper.map(
    assistantBlock("bash-start", "api-bash", [
      {
        type: "tool_use",
        id: "bash-call",
        name: "Bash",
        input: { command: "sleep 30" },
      },
    ]),
  );
  events.push(
    ...mapper.map({
      type: "tool_progress",
      tool_use_id: "bash-call-heartbeat-0",
      tool_name: "Bash",
      parent_tool_use_id: "bash-call",
      elapsed_time_seconds: 5,
      heartbeat: true,
      uuid: randomUUID(),
      session_id: "session-1",
    }),
  );
  events.push(
    ...mapper.map({
      type: "user",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "bash-call", content: "done" },
        ],
      },
    }),
  );
  assert.deepEqual(mapper.finish("completed"), []);
  const rows = buildTimeline(events);
  assert.equal(rows.length, 1);
  const [tool] = rows;
  assert(tool?.type === "tool");
  assert.equal(tool.id, "bash-call");
  assert.equal(tool.status, "completed");
  assert.equal(tool.progress?.elapsedSeconds, 5);
});

test("SDK delegated Bash forwarding cannot assign the child's elapsed time to the Agent invocation", () => {
  const mapper = new ClaudeLiveMapper();
  const events = mapper.map(
    assistantBlock("spawn-message", "api-spawn", [
      {
        type: "tool_use",
        id: "spawn",
        name: "Agent",
        input: { prompt: "Run tests" },
      },
    ]),
  );
  events.push(
    ...mapper.map({
      type: "system",
      subtype: "task_started",
      task_id: "worker",
      tool_use_id: "spawn",
      task_type: "local_agent",
      description: "Run tests",
      uuid: randomUUID(),
      session_id: "session-1",
    }),
  );
  events.push(
    ...mapper.map(
      assistantBlock(
        "child-bash-message",
        "api-child",
        [
          {
            type: "tool_use",
            id: "child-bash",
            name: "Bash",
            input: { command: "pnpm test" },
          },
        ],
        "spawn",
      ),
    ),
  );
  // The SDK's child callback drops the inner parent when forwarding Bash
  // progress; its outer wrapper supplies the Agent invocation as the parent.
  assert.deepEqual(
    mapper.map({
      type: "tool_progress",
      tool_use_id: "bash-progress-0",
      tool_name: "Bash",
      parent_tool_use_id: "spawn",
      elapsed_time_seconds: 12,
      uuid: randomUUID(),
      session_id: "session-1",
    }),
    [],
  );
  events.push(
    ...mapper.map({
      type: "tool_progress",
      tool_use_id: "child-bash-heartbeat-0",
      tool_name: "Bash",
      parent_tool_use_id: "child-bash",
      elapsed_time_seconds: 8,
      heartbeat: true,
      uuid: randomUUID(),
      session_id: "session-1",
    }),
  );
  const rows = buildTimeline(events);
  const invocation = rows.find((row) => row.id === "spawn");
  assert(invocation?.type === "tool");
  assert.equal(invocation.progress, undefined);
  const child = rows.find((row) => row.type === "subagent");
  assert(child?.type === "subagent");
  assert.equal(child.timeline.length, 1);
  const [bash] = child.timeline;
  assert(bash?.type === "tool");
  assert.equal(bash.id, "child-bash");
  assert.equal(bash.progress?.elapsedSeconds, 8);
  assert(
    !mapper.finish("completed").some((event) => event.type === "system.notice"),
  );
});

function stream(
  event: SDKPartialAssistantMessage["event"],
): SDKPartialAssistantMessage {
  return {
    type: "stream_event" as const,
    uuid: randomUUID(),
    session_id: "session-1",
    parent_tool_use_id: null,
    event,
  };
}

function startMessage(id: string) {
  return stream({
    type: "message_start",
    message: { id, content: [] } as unknown as SDKAssistantMessage["message"],
  });
}

function textStart(index: number, text = "") {
  return stream({
    type: "content_block_start",
    index,
    content_block: { type: "text", text, citations: [] },
  });
}

function textDelta(index: number, text: string) {
  return stream({
    type: "content_block_delta",
    index,
    delta: { type: "text_delta", text },
  });
}

function assistantBlock(
  uuid: string,
  messageId: string,
  content: SDKAssistantMessage["message"]["content"],
  parent: string | null = null,
) {
  return {
    type: "assistant",
    uuid,
    session_id: "session-1",
    parent_tool_use_id: parent,
    message: { id: messageId, role: "assistant", content },
  } as SDKAssistantMessage;
}

test("streams text after empty and thinking blocks, then replaces it with the complete block", () => {
  const mapper = new ClaudeLiveMapper();
  assert.deepEqual(mapper.map(startMessage("api-1")), []);
  assert.deepEqual(mapper.map(textStart(0)), []);
  mapper.map(stream({ type: "content_block_stop", index: 0 }));
  mapper.map(
    stream({
      type: "content_block_start",
      index: 1,
      content_block: { type: "thinking", thinking: "", signature: "" },
    }),
  );
  assert.deepEqual(
    mapper.map(
      stream({
        type: "content_block_delta",
        index: 1,
        delta: {
          type: "thinking_delta",
          thinking: "not displayed",
          estimated_tokens: 3,
        },
      }),
    ),
    [],
  );
  mapper.map(stream({ type: "content_block_stop", index: 1 }));
  assert.deepEqual(mapper.map(textStart(2)), []);
  assert.deepEqual(mapper.map(textDelta(2, "")), []);
  const first = mapper.map(textDelta(2, "Hello"));
  const next = mapper.map(textDelta(2, " world"));
  assert.deepEqual(first, [
    {
      type: "assistant.message",
      id: "api-1:text:2",
      text: "Hello",
      partial: true,
    },
  ]);
  assert.deepEqual(next, [{ ...first[0], text: "Hello world" }]);
  const complete = assistantBlock("complete-1", "api-1", [
    { type: "text", text: "Hello world!", citations: [] },
  ]);
  const final = mapper.map(complete);
  mapper.map(stream({ type: "content_block_stop", index: 2 }));
  mapper.map(stream({ type: "message_stop" }));
  assert.deepEqual(
    buildTimeline([...first, ...next, ...final, ...mapper.map(complete)]),
    [{ type: "assistant.message", id: "api-1:text:2", text: "Hello world!" }],
  );
});

test("keeps successive text blocks, tools, subagent output and API messages separate", () => {
  const mapper = new ClaudeLiveMapper();
  mapper.map(startMessage("api-1"));
  const events = mapper.map(textStart(0, "Before tool"));
  const firstComplete = assistantBlock("complete-1", "api-1", [
    { type: "text", text: "Before tool", citations: [] },
  ]);
  events.push(...mapper.map(firstComplete));
  mapper.map(stream({ type: "content_block_stop", index: 0 }));
  mapper.map(
    stream({
      type: "content_block_start",
      index: 1,
      content_block: {
        type: "tool_use",
        id: "tool-1",
        name: "Read",
        input: {},
      },
    }),
  );
  assert.deepEqual(
    mapper.map(
      stream({
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"path":' },
      }),
    ),
    [],
  );
  events.push(
    ...mapper.map(
      assistantBlock("tool-block", "api-1", [
        {
          type: "tool_use",
          id: "tool-1",
          name: "Read",
          input: { path: "README.md" },
        },
      ]),
    ),
  );
  mapper.map(stream({ type: "content_block_stop", index: 1 }));
  mapper.map(textStart(2));
  events.push(...mapper.map(textDelta(2, "After tool")));
  // A repeated complete block cannot be reassigned to the newly active block.
  events.push(...mapper.map(firstComplete));
  events.push(
    ...mapper.map(
      assistantBlock(
        "child",
        "api-child",
        [{ type: "text", text: "Child output", citations: [] }],
        "tool-agent",
      ),
    ),
    ...mapper.map(
      assistantBlock("complete-2", "api-1", [
        { type: "text", text: "After tool", citations: [] },
      ]),
    ),
  );
  mapper.map(stream({ type: "content_block_stop", index: 2 }));
  mapper.map(stream({ type: "message_stop" }));
  mapper.map(startMessage("api-2"));
  events.push(...mapper.map(textStart(0, "Next message")));
  events.push(
    ...mapper.map(
      assistantBlock("complete-3", "api-2", [
        { type: "text", text: "Next message", citations: [] },
      ]),
    ),
  );
  const rows = buildTimeline(events);
  assert.deepEqual(
    rows.map((row) => row.id),
    ["api-1:text:0", "tool-1", "api-1:text:2", "api-2:text:0"],
  );
  assert.deepEqual(
    rows
      .filter((row) => row.type === "assistant.message")
      .map((row) => [row.text, row.partial]),
    [
      ["Before tool", undefined],
      ["After tool", undefined],
      ["Next message", undefined],
    ],
  );
  assert.deepEqual(rows[1], {
    type: "tool",
    id: "tool-1",
    tool: "Read",
    input: { path: "README.md" },
    output: "",
    status: "running",
  });
});

test("rejects text deltas without their matching stream block", () => {
  const mapper = new ClaudeLiveMapper();
  assert.throws(
    () => mapper.map(textDelta(0, "orphan")),
    /matching content block/,
  );
  assert.throws(() => mapper.map(textStart(0)), /without a message/);
  mapper.map(startMessage("api-1"));
  mapper.map(textStart(0));
  assert.throws(
    () => mapper.map(textDelta(1, "wrong block")),
    /matching content block/,
  );
  mapper.map(stream({ type: "message_stop" }));
  assert.throws(
    () => mapper.map(textDelta(0, "late")),
    /matching content block/,
  );
});

test("withdraws a failed partial when the SDK falls back to a complete API response", () => {
  const mapper = new ClaudeLiveMapper();
  const events = mapper.map(
    assistantBlock("earlier", "api-earlier", [
      { type: "text", text: "Keep this completed message", citations: [] },
    ]),
  );
  mapper.map(startMessage("api-failed"));
  mapper.map(textStart(0));
  events.push(...mapper.map(textDelta(0, "Abandoned partial")));
  // Actual SDK fallback sequence: no message_stop/reset for the failed stream,
  // then a non-streaming assistant response with a new API message ID.
  const replacement = mapper.map(
    assistantBlock("fallback", "api-retry", [
      { type: "text", text: "Recovered answer", citations: [] },
      { type: "tool_use", id: "tool-retry", name: "Read", input: {} },
      { type: "text", text: "Another complete block", citations: [] },
    ]),
  );
  assert.deepEqual(replacement[0], {
    type: "assistant.message.removed",
    id: "api-failed:text:0",
  });
  events.push(...replacement);
  assert.deepEqual(
    buildTimeline(events).map((row) => row.id),
    ["earlier:text:0", "fallback:text:0", "tool-retry", "fallback:text:2"],
  );
  assert.deepEqual(mapper.finish("error"), [
    { type: "tool.completed", id: "tool-retry", status: "failed" },
  ]);
});

test("withdraws abandoned text before a streamed retry and ignores unrelated assistant envelopes", () => {
  const mapper = new ClaudeLiveMapper();
  const previous = assistantBlock("previous", "api-previous", [
    { type: "text", text: "Already completed", citations: [] },
  ]);
  const events = mapper.map(previous);
  mapper.map(startMessage("api-failed"));
  events.push(...mapper.map(textStart(0, "Abandoned")));
  const removed = mapper.map(startMessage("api-retry"));
  assert.deepEqual(removed, [
    { type: "assistant.message.removed", id: "api-failed:text:0" },
  ]);
  events.push(...removed, ...mapper.map(textStart(0, "Recovered")));
  const synthetic = assistantBlock("synthetic", "api-synthetic", [
    { type: "text", text: "No response requested.", citations: [] },
  ]);
  synthetic.message.model = "<synthetic>";
  assert.deepEqual(mapper.map(synthetic), []);
  events.push(...mapper.map(previous));
  events.push(
    ...mapper.map(
      assistantBlock(
        "child",
        "api-child",
        [{ type: "text", text: "Child reply", citations: [] }],
        "tool-agent",
      ),
    ),
  );
  events.push(...mapper.map(textDelta(0, " reply")));
  events.push(
    ...mapper.map(
      assistantBlock("retried", "api-retry", [
        { type: "text", text: "Recovered reply", citations: [] },
      ]),
    ),
  );
  const rows = buildTimeline(events);
  assert.deepEqual(
    rows.map((row) => row.id),
    ["previous:text:0", "api-retry:text:0"],
  );
  assert.deepEqual(
    buildTrajectory(rows).map((row) => row.status),
    ["Completed", "Completed"],
  );
  const finished = mapper.finish("error");
  assert.equal(finished.length, 1);
  assert.equal(finished[0]?.type, "system.notice");
});

test("retains unfinished text with a terminal reason and finalizes only once", () => {
  for (const stopReason of ["interrupted", "error"] as const) {
    const mapper = new ClaudeLiveMapper();
    mapper.map(startMessage("api-stopped"));
    const events = mapper.map(textStart(0, "Keep the partial answer"));
    const stopped = mapper.finish(stopReason);
    assert.deepEqual(stopped, [
      {
        type: "assistant.message",
        id: "api-stopped:text:0",
        text: "Keep the partial answer",
        stopReason,
      },
    ]);
    events.push(...stopped);
    const rows = buildTimeline(events);
    assert.equal(rows.length, 1);
    assert.equal(
      buildTrajectory(rows)[0]?.status,
      stopReason === "interrupted" ? "Interrupted" : "Failed",
    );
    assert.deepEqual(mapper.finish(stopReason), []);
  }
});

test("preserves the SDK's aborted marker when it supplies the last text block", () => {
  const mapper = new ClaudeLiveMapper();
  mapper.map(startMessage("api-aborted"));
  const events = mapper.map(textStart(0, "Cut off"));
  events.push(
    ...mapper.map({
      ...assistantBlock("aborted", "api-aborted", [
        { type: "text", text: "Cut off here", citations: [] },
      ]),
      aborted: true as const,
    }),
  );
  assert.deepEqual(buildTimeline(events), [
    {
      type: "assistant.message",
      id: "api-aborted:text:0",
      text: "Cut off here",
      stopReason: "interrupted",
    },
  ]);
  assert.deepEqual(mapper.finish("interrupted"), []);
});

test("an SDK error envelope does not replace or withdraw the in-flight answer", () => {
  for (const messageId of ["api-pending", "api-error"]) {
    const mapper = new ClaudeLiveMapper();
    mapper.map(startMessage("api-pending"));
    const events = mapper.map(textStart(0, "Useful partial answer"));
    const notice = mapper.map({
      ...assistantBlock("error-notice", messageId, [
        { type: "text", text: "API Error", citations: [] },
      ]),
      error: "server_error" as const,
    });
    assert.deepEqual(notice, [
      {
        type: "assistant.message",
        id: "error-notice:text:0",
        text: "API Error",
      },
    ]);
    const stopped = mapper.finish("error");
    assert.deepEqual(stopped, [
      {
        type: "assistant.message",
        id: "api-pending:text:0",
        text: "Useful partial answer",
        stopReason: "error",
      },
    ]);
    assert.equal(buildTimeline([...events, ...notice, ...stopped]).length, 2);
  }
});
