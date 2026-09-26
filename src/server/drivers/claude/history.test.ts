import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  InMemorySessionStore,
  type SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import { mapClaudeHistory } from "./event-mapper.js";
import { selectClaudeHistory, selectClaudeSubagentHistory } from "./history.js";
import { buildTimeline } from "../../../web/store.js";
import type { TaskStopOutput } from "@anthropic-ai/claude-agent-sdk/sdk-tools";

const sessionId = randomUUID();
function entry(
  type: string,
  uuid: string,
  parentUuid: string | null,
  extra: Record<string, unknown>,
): SessionStoreEntry {
  return { type, uuid, parentUuid, sessionId, isSidechain: false, ...extra };
}
const user = (id: string, parent: string | null, content: string) =>
  entry("user", id, parent, { message: { role: "user", content } });
const assistant = (
  id: string,
  parent: string,
  text: string,
  model = "test-model",
) =>
  entry("assistant", id, parent, {
    message: { role: "assistant", model, content: [{ type: "text", text }] },
  });
const command = (
  id: string,
  parent: string | null,
  name = "/context",
  args = "",
) =>
  user(
    id,
    parent,
    `<command-name>${name}</command-name>\n<command-message>${name.slice(1)}</command-message>\n<command-args>${args}</command-args>`,
  );
const output = (id: string, parent: string, text: string) =>
  entry("system", id, parent, {
    subtype: "local_command",
    content: `<local-command-stdout>${text}</local-command-stdout>`,
  });

async function history(entries: SessionStoreEntry[]) {
  const messages = await selectClaudeHistory(
    entries,
    { projectKey: "-history-fixture", sessionId },
    "/history-fixture",
  );
  return mapClaudeHistory(messages).map((event) =>
    "text" in event ? [event.type, event.text] : [event.type],
  );
}

test("restores notification origins after SDK selection without adding user turns", async () => {
  const entries = [user("request", null, "Run three agents")];
  let parent = "request";
  for (let index = 0; index < 3; index++) {
    const id = `notification-${index}`;
    entries.push({
      ...user(id, parent, `<task-notification>${index}</task-notification>`),
      origin: { kind: "task-notification" },
    });
    entries.push(assistant(`answer-${index}`, id, `Result ${index}`));
    parent = `answer-${index}`;
  }
  entries.push(user("followup", parent, "What is the session ID?"));
  const original = structuredClone(entries);
  const selected = await selectClaudeHistory(
    entries,
    { projectKey: "-history-fixture", sessionId },
    "/history-fixture",
  );
  assert.equal(selected.filter((message) => "origin" in message).length, 3);
  assert.equal(
    "origin" in selected.find((message) => message.uuid === "request")!,
    false,
  );
  const rows = buildTimeline(mapClaudeHistory(selected));
  assert.deepEqual(
    rows.filter((row) => row.type === "user.message").map((row) => row.id),
    ["request", "followup"],
  );
  assert.deepEqual(
    rows
      .filter((row) => row.type === "assistant.message")
      .map((row) => row.text),
    ["Result 0", "Result 1", "Result 2"],
  );
  assert.deepEqual(entries, original);
});

test("keeps notification-looking user text with absent or human origin", async () => {
  const text =
    "<task-notification><task-id>example</task-id></task-notification>";
  assert.deepEqual(
    await history([
      user("unattributed", null, text),
      { ...user("human", "unattributed", text), origin: { kind: "human" } },
    ]),
    [
      ["user.message", text],
      ["user.message", text],
    ],
  );
});

test("retains task-notification subkinds as conversation input in history", async () => {
  const subkinds = ["scheduled-trigger", "peer-send-message", "projects-relay"];
  const entries = subkinds.map((subkind, index) => ({
    ...user(subkind, index === 0 ? null : subkinds[index - 1]!, subkind),
    origin: { kind: "task-notification", subkind },
  }));
  assert.deepEqual(
    await history(entries),
    subkinds.map((subkind) => ["user.message", subkind]),
  );
});

test("restores command output siblings, a final system-only command, and normal responses", async () => {
  const entries = [
    command("context", null),
    output("context-output", "context", "Context usage"),
    assistant(
      "placeholder",
      "context",
      "No response requested.",
      "<synthetic>",
    ),
    user("question", "placeholder", "What is 2+2?"),
    assistant("answer", "question", "4"),
    entry("attachment", "attachment", "answer", {}),
    entry("system", "help", "attachment", {
      subtype: "local_command",
      content: "/help",
    }),
    output("help-output", "help", "/help isn't available in this environment."),
  ];
  const original = structuredClone(entries);
  assert.deepEqual(await history(entries), [
    ["user.message", "/context"],
    ["assistant.message", "Context usage"],
    ["user.message", "What is 2+2?"],
    ["assistant.message", "4"],
    ["user.message", "/help"],
    ["assistant.message", "/help isn't available in this environment."],
  ]);
  assert.deepEqual(
    entries,
    original,
    "native transcript entries must not be mutated",
  );
});

test("keeps repeated commands and output chunks ordered without replay duplicates", async () => {
  const firstOutput = output("first-output", "first", "First");
  assert.deepEqual(
    await history([
      command("first", null, "/model", "example-model"),
      firstOutput,
      firstOutput,
      output("second-output", "first", "More"),
      assistant(
        "placeholder",
        "first",
        "No response requested.",
        "<synthetic>",
      ),
      command("second", "placeholder", "/model"),
      output("third-output", "second", "Current"),
    ]),
    [
      ["user.message", "/model example-model"],
      ["assistant.message", "First"],
      ["assistant.message", "More"],
      ["user.message", "/model"],
      ["assistant.message", "Current"],
    ],
  );
});

test("restores a session containing only an unsupported local command", async () => {
  assert.deepEqual(
    await history([
      entry("system", "help", null, {
        subtype: "local_command",
        content: "/help",
      }),
      output("help-output", "help", "Command unavailable"),
    ]),
    [
      ["user.message", "/help"],
      ["assistant.message", "Command unavailable"],
    ],
  );
});

test("preserves SDK branch selection and excludes sidechains and metadata", async () => {
  assert.deepEqual(
    await history([
      user("root", null, "Hello"),
      command("abandoned", "root"),
      output("abandoned-output", "abandoned", "Old branch"),
      user("current", "root", "Current branch"),
      assistant("answer", "current", "Current answer"),
      {
        ...output("side-output", "current", "Hidden sidechain"),
        isSidechain: true,
      },
      { ...output("meta-output", "current", "Hidden metadata"), isMeta: true },
    ]),
    [
      ["user.message", "Hello"],
      ["user.message", "Current branch"],
      ["assistant.message", "Current answer"],
    ],
  );
});

test("does not resurrect commands discarded by compaction", async () => {
  assert.deepEqual(
    await history([
      command("old", null),
      output("old-output", "old", "Before compaction"),
      entry("system", "boundary", null, {
        subtype: "compact_boundary",
        compactMetadata: { trigger: "auto", preTokens: 1000 },
      }),
      user("summary", "boundary", "Summary"),
      assistant("answer", "summary", "After compaction"),
    ]),
    [
      ["user.message", "Summary"],
      ["assistant.message", "After compaction"],
    ],
  );
});

test("restores outputs for commands preserved across a compaction boundary", async () => {
  assert.deepEqual(
    await history([
      command("kept", null),
      output("kept-output", "kept", "Kept result"),
      entry("system", "boundary", null, {
        subtype: "compact_boundary",
        compactMetadata: {
          preservedMessages: { anchorUuid: "boundary", uuids: ["kept"] },
        },
      }),
      user("next", "boundary", "Continue"),
      assistant("answer", "next", "Done"),
    ]),
    [
      ["user.message", "/context"],
      ["assistant.message", "Kept result"],
      ["user.message", "Continue"],
      ["assistant.message", "Done"],
    ],
  );
});

test("restores the selected message's current native toolUseResult by UUID", async () => {
  const nativeResult = {
    stdout: "stdout",
    stderr: "stderr",
    interrupted: false,
    persistedOutputPath: "/work/output.txt",
  };
  const toolResult = (uuid: string, parent: string, toolUseResult?: unknown) =>
    entry("user", uuid, parent, {
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: uuid,
            content: "Text shown to the model",
          },
        ],
      },
      ...(toolUseResult === undefined ? {} : { toolUseResult }),
    });
  const entries = [
    user("root", null, "Run commands"),
    toolResult("abandoned-result", "root", { stdout: "abandoned" }),
    assistant("current", "root", "Current branch"),
    toolResult("current-result", "current", { stdout: "superseded duplicate" }),
    toolResult("current-result", "current", nativeResult),
    assistant("continue", "current-result", "Continue"),
    toolResult("missing-result", "continue"),
  ];
  const original = structuredClone(entries);
  const selected = await selectClaudeHistory(
    entries,
    { projectKey: "-history-fixture", sessionId },
    "/history-fixture",
  );
  const completed = mapClaudeHistory(selected).filter(
    (event) => event.type === "tool.completed",
  );
  assert.deepEqual(completed, [
    {
      type: "tool.completed",
      id: "current-result",
      status: "completed",
      output: "Text shown to the model",
      details: {
        type: "claudeToolResult",
        result: nativeResult,
        content: "Text shown to the model",
      },
    },
    {
      type: "tool.completed",
      id: "missing-result",
      status: "completed",
      output: "Text shown to the model",
      details: { type: "claudeToolResult", content: "Text shown to the model" },
    },
  ]);
  assert.deepEqual(entries, original);
});

test("reads native child transcripts with SDK identity and keeps their results out of the main conversation", async () => {
  const store = new InMemorySessionStore();
  const key = { projectKey: "-history-fixture", sessionId };
  const result = { stdout: "child stdout", stderr: "", interrupted: false };
  await store.append({ ...key, subpath: "subagents/agent-native-child" }, [
    {
      type: "agent_metadata",
      agentId: "native-child",
      toolUseId: "spawn",
      parentAgentId: null,
      cwd: "/work/child-worktree",
    },
    { ...user("child-prompt", null, "Child task"), isSidechain: true },
    entry("assistant", "child-tool", "child-prompt", {
      isSidechain: true,
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "child-bash",
            name: "Bash",
            input: { command: "pwd" },
          },
        ],
      },
    }),
    entry("user", "child-result", "child-tool", {
      isSidechain: true,
      toolUseResult: result,
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "child-bash",
            content: "child stdout",
          },
        ],
      },
    }),
    {
      ...user("child-notification", "child-result", "Background task finished"),
      origin: { kind: "task-notification" },
      isSidechain: true,
    },
    {
      ...assistant("child-answer", "child-notification", "Child answer"),
      isSidechain: true,
    },
  ]);
  const children = await selectClaudeSubagentHistory(
    store,
    key,
    "/history-fixture",
  );
  assert.equal(children.length, 1);
  assert.equal(children[0]?.agentId, "native-child");
  assert(
    children[0]!.messages.every(
      (message) => message.parent_tool_use_id === "spawn",
    ),
  );
  const rows = buildTimeline(mapClaudeHistory([], children));
  assert.equal(rows.length, 1);
  const [child] = rows;
  assert(child?.type === "subagent");
  assert.equal(child.cwd, "/work/child-worktree");
  assert.deepEqual(
    child.timeline
      .filter((row) => row.type === "user.message")
      .map((row) => row.text),
    ["Child task"],
  );
  assert.equal(
    child.state,
    "unknown",
    "a final-looking assistant message is not a task terminal event",
  );
  const tool = child.timeline.find((row) => row.type === "tool");
  assert(tool?.type === "tool");
  assert.equal(tool.output, "child stdout");
  assert.deepEqual(tool.details, {
    type: "claudeToolResult",
    result,
    content: "child stdout",
  });
  assert(
    child.timeline.some(
      (row) => row.type === "assistant.message" && row.text === "Child answer",
    ),
  );
});

for (const retainLaunch of [true, false]) {
  for (const successful of [true, false]) {
    test(`TaskStop history ${successful ? "retains interruption" : "does not invent interruption"} with ${retainLaunch ? "a recorded" : "an unavailable"} launch and a later child snapshot`, async () => {
      const nativeStop: TaskStopOutput = {
        task_id: "worker",
        task_type: "local_agent",
        message: successful
          ? "Successfully stopped worker"
          : "Stop was refused",
      };
      const entries: SessionStoreEntry[] = [user("root", null, "Run worker")];
      let predecessor = "root";
      if (retainLaunch) {
        entries.push(
          entry("assistant", "launch", predecessor, {
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "spawn",
                  name: "Agent",
                  input: { description: "Worker", prompt: "Check parser" },
                },
              ],
            },
          }),
        );
        entries.push(
          entry("user", "launched", "launch", {
            toolUseResult: {
              status: "async_launched",
              agentId: "worker",
              description: "Worker",
              prompt: "Check parser",
              outputFile: "/work/worker.txt",
            },
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "spawn",
                  content: "Agent launched",
                },
              ],
            },
          }),
        );
        predecessor = "launched";
      }
      entries.push(
        entry("assistant", "stop", predecessor, {
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "stop-call",
                name: "TaskStop",
                input: { task_id: "worker-name" },
              },
            ],
          },
        }),
      );
      entries.push(
        entry("user", "stopped", "stop", {
          toolUseResult: nativeStop,
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "stop-call",
                content: nativeStop.message,
                is_error: !successful,
              },
            ],
          },
        }),
      );
      const key = { projectKey: "-history-fixture", sessionId };
      const selected = await selectClaudeHistory(
        entries,
        key,
        "/history-fixture",
      );
      const store = new InMemorySessionStore();
      await store.append({ ...key, subpath: "subagents/agent-worker" }, [
        { type: "agent_metadata", toolUseId: "spawn", parentAgentId: null },
        { ...user("child-start", null, "Child task"), isSidechain: true },
        entry("assistant", "child-tools", "child-start", {
          isSidechain: true,
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "pending-read",
                name: "Read",
                input: { file_path: "parser.ts" },
              },
              {
                type: "tool_use",
                id: "finished-read",
                name: "Read",
                input: { file_path: "test.ts" },
              },
            ],
          },
        }),
        entry("user", "child-result", "child-tools", {
          isSidechain: true,
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "finished-read",
                content: "Finished source",
              },
            ],
          },
        }),
      ]);
      const children = await selectClaudeSubagentHistory(
        store,
        key,
        "/history-fixture",
      );
      const rows = buildTimeline(mapClaudeHistory(selected, children));
      const child = rows.find(
        (row) => row.type === "subagent" && row.agentId === "worker",
      );
      assert(child?.type === "subagent");
      assert.equal(child.state, successful ? "interrupted" : "unknown");
      if (successful) assert.equal(child.statusMessage, nativeStop.message);
      const pending = child.timeline.find((row) => row.id === "pending-read");
      assert(pending?.type === "tool");
      assert.equal(pending.status, successful ? "interrupted" : "incomplete");
      const completed = child.timeline.find(
        (row) => row.id === "finished-read",
      );
      assert(completed?.type === "tool");
      assert.equal(completed.status, "completed");
      assert.equal(completed.output, "Finished source");
      if (!retainLaunch) {
        assert.equal(child.name, undefined);
        assert.equal(child.prompt, undefined);
        assert.equal(child.role, undefined);
      }
      const stop = rows.find((row) => row.id === "stop-call");
      assert(stop?.type === "tool");
      assert.equal(stop.status, successful ? "completed" : "failed");
    });
  }
}

for (const oldStatus of ["async_launched", "completed"] as const) {
  for (const parentFirst of [true, false]) {
    test(`root stop survives a later ${oldStatus} leaf result in ${parentFirst ? "parent-first" : "leaf-first"} child history`, async () => {
      const key = { projectKey: "-history-fixture", sessionId };
      const nativeStop: TaskStopOutput = {
        task_id: "leaf",
        task_type: "local_agent",
        message: "Successfully stopped leaf",
      };
      const call = (
        uuid: string,
        parent: string,
        id: string,
        name: string,
        input: Record<string, unknown>,
      ) =>
        entry("assistant", uuid, parent, {
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id, name, input }],
          },
        });
      const result = (
        uuid: string,
        parent: string,
        id: string,
        toolUseResult: unknown,
      ) =>
        entry("user", uuid, parent, {
          toolUseResult,
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: id,
                content: "Native tool result",
              },
            ],
          },
        });
      const main = await selectClaudeHistory(
        [
          user("root", null, "Check the tree"),
          call("parent-launch", "root", "parent-spawn", "Agent", {
            prompt: "Delegate checks",
          }),
          result("parent-launched", "parent-launch", "parent-spawn", {
            status: "async_launched",
            agentId: "parent",
            description: "Delegate checks",
            prompt: "Delegate checks",
            outputFile: "/work/parent.txt",
          }),
          call("stop-leaf", "parent-launched", "stop-leaf-call", "TaskStop", {
            task_id: "leaf",
          }),
          result("leaf-stopped", "stop-leaf", "stop-leaf-call", nativeStop),
        ],
        key,
        "/history-fixture",
      );
      const store = new InMemorySessionStore();
      const leafResult =
        oldStatus === "async_launched"
          ? {
              status: oldStatus,
              agentId: "leaf",
              description: "Leaf task",
              prompt: "Read parser",
              outputFile: "/work/leaf.txt",
            }
          : {
              // Current TaskStop permits a completed local_agent retained by
              // native keepalive reasons (or an observer). Those runtime flags
              // are not serialized in the Agent tool result itself.
              status: oldStatus,
              agentId: "leaf",
              prompt: "Read parser",
              content: [{ type: "text", text: "Old leaf completion" }],
              totalToolUseCount: 1,
              totalDurationMs: 500,
              totalTokens: 10,
            };
      await store.append(
        { ...key, subpath: "subagents/agent-parent" },
        [
          {
            type: "agent_metadata",
            toolUseId: "parent-spawn",
            parentAgentId: null,
          },
          user("parent-request", null, "Delegate checks"),
          call("leaf-launch", "parent-request", "leaf-spawn", "Agent", {
            prompt: "Read parser",
            description: "Leaf task",
          }),
          result("leaf-returned", "leaf-launch", "leaf-spawn", leafResult),
        ].map((entry) => ({ ...entry, isSidechain: true })),
      );
      await store.append(
        { ...key, subpath: "subagents/agent-leaf" },
        [
          {
            type: "agent_metadata",
            toolUseId: "leaf-spawn",
            parentAgentId: "parent",
          },
          user("leaf-request", null, "Read parser"),
          call("leaf-read", "leaf-request", "leaf-pending-read", "Read", {
            file_path: "parser.ts",
          }),
        ].map((entry) => ({ ...entry, isSidechain: true })),
      );
      const children = await selectClaudeSubagentHistory(
        store,
        key,
        "/history-fixture",
      );
      const orderedChildren = (
        parentFirst ? ["parent", "leaf"] : ["leaf", "parent"]
      ).map((agentId) => children.find((child) => child.agentId === agentId)!);
      const rows = buildTimeline(mapClaudeHistory(main, orderedChildren));
      const leaf = rows.find(
        (row) => row.type === "subagent" && row.agentId === "leaf",
      );
      assert(leaf?.type === "subagent");
      assert.equal(leaf.state, "interrupted");
      assert.equal(leaf.statusMessage, nativeStop.message);
      assert.equal(leaf.parentAgentId, "parent");
      const read = leaf.timeline.find((row) => row.id === "leaf-pending-read");
      assert(read?.type === "tool");
      assert.equal(read.status, "interrupted");
      const parent = rows.find(
        (row) => row.type === "subagent" && row.agentId === "parent",
      );
      assert(parent?.type === "subagent");
      assert.equal(parent.state, "unknown");
      const delegatedCall = parent.timeline.find(
        (row) => row.id === "leaf-spawn",
      );
      assert(delegatedCall?.type === "tool");
      assert.equal(delegatedCall.status, "completed");
    });
  }
}
