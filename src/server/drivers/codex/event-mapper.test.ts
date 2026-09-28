import assert from "node:assert/strict";
import test from "node:test";
import { buildTimeline } from "../../../web/store.js";
import {
  mapItemEvents,
  mapSubagentThread,
  mapThreadEvents,
  mapThreadSummary,
} from "./event-mapper.js";
import type { CodexThread, CodexThreadItem } from "./types.js";

const thread: CodexThread = {
  id: "thread-1",
  preview: "Inspect the project",
  name: null,
  cwd: "/work/project",
  createdAt: 1_700_000_000,
  updatedAt: 1_700_000_100,
  status: { type: "idle" },
  parentThreadId: null,
  agentNickname: null,
  agentRole: null,
  source: "appServer",
  turns: [
    {
      id: "turn-1",
      status: "completed",
      error: null,
      items: [
        {
          type: "userMessage",
          id: "user-1",
          content: [{ type: "text", text: "hello" }],
        },
        {
          type: "commandExecution",
          id: "command-1",
          command: "pwd",
          cwd: "/work/project",
          status: "completed",
          commandActions: [{ type: "unknown", command: "pwd" }],
          aggregatedOutput: "/work/project\n",
          exitCode: 0,
          durationMs: 7,
          processId: null,
          source: "agent",
          pluginId: null,
          scriptPath: null,
        },
        {
          type: "agentMessage",
          id: "agent-1",
          text: "done",
          phase: "final_answer",
        },
      ],
    },
  ],
};

test("maps Codex thread metadata without exposing its native ID", () => {
  const summary = mapThreadSummary(thread);
  assert.equal(summary.title, "Inspect the project");
  assert.equal(
    summary.updatedAt,
    new Date(thread.updatedAt * 1_000).toISOString(),
  );
  assert.equal("sessionId" in summary, false);
  assert.equal(mapThreadSummary({ ...thread, preview: "" }).title, undefined);
});

test("maps Codex history into materialized timeline rows", () => {
  const rows = buildTimeline(mapThreadEvents(thread, () => "racco-agent"));
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], {
    imageCount: 0,
    type: "user.message",
    id: "user-1",
    text: "hello",
  });
  assert.deepEqual(rows[1], {
    type: "tool",
    id: "command-1",
    tool: "command",
    input: { command: "pwd", cwd: "/work/project" },
    details: {
      type: "commandExecution",
      id: "command-1",
      command: "pwd",
      cwd: "/work/project",
      status: "completed",
      commandActions: [{ type: "unknown", command: "pwd" }],
      aggregatedOutput: "/work/project\n",
      exitCode: 0,
      durationMs: 7,
      processId: null,
      source: "agent",
      pluginId: null,
      scriptPath: null,
    },
    output: "/work/project\n",
    status: "completed",
  });
  assert.deepEqual(rows[2], {
    type: "assistant.message",
    id: "agent-1",
    text: "done",
    phase: "final_answer",
  });
});

test("native turn history terminates unfinished tools without inventing successful results", () => {
  const pending: CodexThreadItem = {
    type: "commandExecution",
    id: "unfinished",
    command: "long task",
    cwd: "/work/project",
    status: "inProgress",
    commandActions: [],
    aggregatedOutput: "partial output",
    exitCode: null,
    durationMs: null,
    processId: "process",
    source: "agent",
    pluginId: null,
    scriptPath: null,
  };
  for (const [turnStatus, toolStatus] of [
    ["completed", "incomplete"],
    ["interrupted", "interrupted"],
    ["failed", "failed"],
    ["inProgress", "running"],
  ] as const) {
    const snapshot: CodexThread = {
      ...thread,
      turns: [
        { id: "turn", status: turnStatus, error: null, items: [pending] },
      ],
    };
    const row = buildTimeline(mapThreadEvents(snapshot, () => "unused"))[0];
    assert(row.type === "tool");
    assert.equal(row.status, toolStatus);
    assert.equal(row.output, "partial output");
    assert.deepEqual(row.details, pending);
  }
});

test("MCP failure is not completed merely because its optional error payload is absent", () => {
  const events = mapItemEvents(
    {
      type: "mcpToolCall",
      id: "mcp",
      server: "server",
      tool: "tool",
      status: "failed",
      arguments: {},
      error: null,
      result: null,
    },
    () => "unused",
    "snapshot",
  );
  assert.equal(
    events.find((event) => event.type === "tool.completed")?.status,
    "failed",
  );
});

test("preserves failed turn diagnostics in resumed history", () => {
  const failedThread: CodexThread = {
    ...thread,
    turns: [
      {
        id: "turn-failed",
        status: "failed",
        error: { message: "model unavailable" },
        items: [],
      },
    ],
  };

  assert.deepEqual(
    mapThreadEvents(failedThread, () => "racco-agent"),
    [
      {
        type: "system.notice",
        id: "turn-failed:error",
        text: "model unavailable",
        level: "error",
      },
    ],
  );
});

test("maps Codex subagent activity without exposing provider thread IDs", () => {
  const providerThreadId = "provider-child-thread";
  const raccoAgentId = "racco-agent";
  const events = [
    ...mapItemEvents(
      {
        type: "subAgentActivity",
        id: "activity-started",
        kind: "started",
        agentThreadId: providerThreadId,
        agentPath: "/root/reviewer",
      },
      () => raccoAgentId,
      "snapshot",
    ),
    ...mapItemEvents(
      {
        type: "collabAgentToolCall",
        id: "spawn-call",
        tool: "spawnAgent",
        status: "completed",
        senderThreadId: "provider-root-thread",
        receiverThreadIds: [providerThreadId],
        prompt: "Review the implementation",
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        agentsStates: {
          [providerThreadId]: { status: "running", message: null },
        },
      },
      () => raccoAgentId,
      "snapshot",
    ),
  ];

  assert.deepEqual(events, [
    {
      type: "subagent.started",
      id: "activity-started",
      agentId: raccoAgentId,
      name: "reviewer",
      agentPath: "/root/reviewer",
    },
    {
      type: "subagent.state",
      id: "activity-started:state",
      agentId: raccoAgentId,
      state: "starting",
    },
    {
      type: "subagent.started",
      id: "spawn-call:spawn:0",
      agentId: raccoAgentId,
      prompt: "Review the implementation",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    },
    {
      type: "subagent.state",
      id: "spawn-call:state:1",
      agentId: raccoAgentId,
      state: "running",
      message: undefined,
    },
  ]);
  assert.equal(JSON.stringify(events).includes(providerThreadId), false);
});

test("maps a targeted child thread into subagent metadata, output, and state", () => {
  const child: CodexThread = {
    ...thread,
    id: "provider-child-thread",
    parentThreadId: "provider-root-thread",
    preview: "",
    agentNickname: "Turing",
    agentRole: "reviewer",
    source: {
      subAgent: {
        thread_spawn: {
          parent_thread_id: "provider-root-thread",
          depth: 1,
          agent_path: "/root/reviewer",
          agent_nickname: "Turing",
          agent_role: "reviewer",
        },
      },
    },
    turns: [
      {
        id: "provider-child-turn",
        status: "completed",
        error: null,
        items: [
          {
            type: "agentMessage",
            id: "child-message",
            text: "Review complete",
            phase: "final_answer",
          },
        ],
      },
    ],
  };

  const events = mapSubagentThread(child, "racco-agent", () => "nested-agent");
  assert.deepEqual(events, [
    {
      type: "subagent.started",
      id: "racco-agent:metadata",
      agentId: "racco-agent",
      parentAgentId: undefined,
      name: "Turing",
      agentPath: "/root/reviewer",
      cwd: "/work/project",
      role: "reviewer",
    },
    {
      type: "subagent.event",
      id: "racco-agent:event:assistant.message:child-message",
      agentId: "racco-agent",
      event: {
        type: "assistant.message",
        id: "racco-agent:child-message",
        text: "Review complete",
        phase: "final_answer",
      },
    },
    {
      type: "subagent.state",
      id: "racco-agent:state",
      agentId: "racco-agent",
      state: "completed",
      message: undefined,
    },
  ]);
  assert.equal(JSON.stringify(events).includes("provider-child-thread"), false);
  assert.equal(JSON.stringify(events).includes("provider-child-turn"), false);
});

test("resolves nested collaboration events to Racco agent IDs", () => {
  const child: CodexThread = {
    ...thread,
    parentThreadId: "provider-parent",
    turns: [
      {
        id: "child-turn",
        status: "completed",
        error: null,
        items: [
          {
            type: "collabAgentToolCall",
            id: "nested-spawn",
            tool: "spawnAgent",
            status: "completed",
            senderThreadId: "provider-child",
            receiverThreadIds: ["provider-grandchild"],
            prompt: "Check one file",
            model: null,
            reasoningEffort: null,
            agentsStates: {
              "provider-grandchild": { status: "running", message: null },
            },
          },
        ],
      },
    ],
  };
  const events = mapSubagentThread(child, "racco-child", (providerId) => {
    assert.equal(providerId, "provider-grandchild");
    return "racco-grandchild";
  });
  assert(
    events.some(
      (event) =>
        event.type === "subagent.started" &&
        event.agentId === "racco-grandchild" &&
        event.prompt === "Check one file",
    ),
  );
  assert.equal(JSON.stringify(events).includes("provider-grandchild"), false);
});

test("web search live envelopes distinguish running calls from completed empty results", () => {
  const item: Extract<CodexThreadItem, { type: "webSearch" }> = {
    type: "webSearch",
    id: "search",
    query: "北京天气",
    action: { type: "search", query: "北京天气", queries: null },
    results: null,
  };
  const started = mapItemEvents(item, () => undefined, "started");
  const [running] = buildTimeline(started);
  assert(running.type === "tool");
  assert.equal(running.status, "running");
  for (const results of [
    null,
    [],
    [{ url: "https://example.com", title: "天气" }],
  ]) {
    const completed = { ...item, results };
    const [row] = buildTimeline([
      ...started,
      ...mapItemEvents(completed, () => undefined, "completed"),
    ]);
    assert(row.type === "tool");
    assert.equal(row.status, "completed");
    assert.equal(row.tool, "webSearch");
    assert.deepEqual(row.input, { query: item.query, action: item.action });
    assert.deepEqual(row.details, completed);
    assert.equal(
      row.output,
      results === null ? "" : JSON.stringify(results, null, 2),
    );
  }
});

test("web search history preserves completed actions in both main and child timelines", () => {
  for (const action of [
    { type: "search", query: null, queries: ["北京天气", "上海天气"] },
    { type: "openPage", url: "https://example.com/weather" },
    { type: "findInPage", url: "https://example.com/weather", pattern: "温度" },
    { type: "other" },
  ] as const) {
    const item: CodexThreadItem = {
      type: "webSearch",
      id: "search",
      query: "",
      action: structuredClone(action) as Extract<
        CodexThreadItem,
        { type: "webSearch" }
      >["action"],
      results: [],
    };
    const history: CodexThread = {
      ...thread,
      turns: [{ id: "turn", status: "completed", error: null, items: [item] }],
    };
    const [main] = buildTimeline(mapThreadEvents(history, () => undefined));
    const [child] = buildTimeline(
      mapSubagentThread(history, "child", () => undefined),
    );
    assert(main.type === "tool");
    assert(child.type === "subagent");
    assert.deepEqual(child.timeline, [{ ...main, id: "child:search" }]);
    assert.equal(main.status, "completed");
    assert.deepEqual(main.details, item);
  }
});

test("unfinished web searches follow native turn termination without inventing success", () => {
  const item: CodexThreadItem = {
    type: "webSearch",
    id: "search",
    query: "",
    action: null,
    results: null,
  };
  for (const [turnStatus, expected] of [
    ["inProgress", "running"],
    ["completed", "incomplete"],
    ["interrupted", "interrupted"],
    ["failed", "failed"],
  ] as const) {
    const [row] = buildTimeline(
      mapThreadEvents(
        {
          ...thread,
          turns: [
            { id: "turn", status: turnStatus, error: null, items: [item] },
          ],
        },
        () => undefined,
      ),
    );
    assert(row.type === "tool");
    assert.equal(row.status, expected);
  }
});
