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
      ...assistant("child-answer", "child-result", "Child answer"),
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
