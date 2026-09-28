import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  InMemorySessionStore,
  type SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import { ClaudeActivityTracker } from "./activity-tracker.js";
import { mapClaudeHistory } from "./event-mapper.js";
import { selectClaudeHistory, selectClaudeSubagentHistory } from "./history.js";
import { buildTimeline } from "../../../web/store.js";

const key = {
  projectKey: "-notification-fixture",
  sessionId: randomUUID(),
};
const request: SessionStoreEntry = {
  type: "user",
  uuid: "request",
  parentUuid: null,
  sessionId: key.sessionId,
  message: { role: "user", content: "Run a weather worker" },
};
const launch: SessionStoreEntry[] = [
  request,
  {
    type: "assistant",
    uuid: "launch",
    parentUuid: "request",
    sessionId: key.sessionId,
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "spawn",
          name: "Agent",
          input: { description: "Weather worker", prompt: "Check weather" },
        },
      ],
    },
  },
  {
    type: "user",
    uuid: "launch-result",
    parentUuid: "launch",
    sessionId: key.sessionId,
    toolUseResult: { agentId: "worker", status: "async_launched" },
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
  },
];
function notice(
  status: string,
  parentUuid = "launch-result",
  uuid = "notice",
): SessionStoreEntry {
  return {
    type: "user",
    uuid,
    parentUuid,
    sessionId: key.sessionId,
    origin: { kind: "task-notification" },
    message: {
      role: "user",
      content: `<task-notification>\n<task-id>worker</task-id>\n<tool-use-id>spawn</tool-use-id>\n<output-file>/tmp/worker.output</output-file>\n<status>${status}</status>\n<summary>Weather worker ${status}</summary>\n<note>The task may be resumed.</note>\n<result>Forecast text with an embedded <status>failed</status>.</result>\n</task-notification>`,
    },
  };
}
async function restored(entries: SessionStoreEntry[], withChild = true) {
  const store = new InMemorySessionStore();
  if (withChild)
    await store.append({ ...key, subpath: "subagents/agent-worker" }, [
      { type: "agent_metadata", toolUseId: "spawn" },
      { ...request, uuid: "child-request", isSidechain: true },
      {
        type: "assistant",
        uuid: "child-tool",
        parentUuid: "child-request",
        isSidechain: true,
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "child-read",
              name: "Read",
              input: { file_path: "weather.txt" },
            },
          ],
        },
      },
    ]);
  return buildTimeline(
    mapClaudeHistory(
      await selectClaudeHistory(entries, key, "/notification-fixture"),
      await selectClaudeSubagentHistory(store, key, "/notification-fixture"),
    ),
  );
}

for (const [status, expected, toolStatus] of [
  ["completed", "completed", "incomplete"],
  ["failed", "error", "failed"],
  ["stopped", "interrupted", "interrupted"],
] as const) {
  test(`refresh preserves native ${status} notifications and agrees with the live task state`, async () => {
    const entries = [...launch, notice(status)];
    const original = structuredClone(entries);
    const rows = await restored(entries);
    const child = rows.find((row) => row.type === "subagent");
    assert(child?.type === "subagent");
    assert.equal(child.state, expected);
    assert.equal(child.statusMessage, `Weather worker ${status}`);
    const tool = child.timeline.find((row) => row.type === "tool");
    assert(tool?.type === "tool");
    assert.equal(tool.status, toolStatus);
    assert.deepEqual(
      rows.filter((row) => row.type === "user.message").map((row) => row.id),
      ["request"],
    );
    assert.equal(rows.filter((row) => row.type === "subagent").length, 1);
    assert.deepEqual(entries, original);

    const tracker = new ClaudeActivityTracker();
    const live = [
      ...tracker.map({
        type: "system",
        subtype: "task_started",
        task_id: "worker",
        tool_use_id: "spawn",
        task_type: "local_agent",
        description: "Weather worker",
        uuid: randomUUID(),
        session_id: key.sessionId,
      })!,
      ...tracker.map({
        type: "system",
        subtype: "task_notification",
        task_id: "worker",
        tool_use_id: "spawn",
        status,
        summary: `Weather worker ${status}`,
        output_file: "/tmp/worker.output",
        uuid: randomUUID(),
        session_id: key.sessionId,
      })!,
      ...tracker.finish("incomplete"),
    ];
    const liveChild = buildTimeline(live)[0]!;
    assert(liveChild.type === "subagent");
    assert.equal(child.state, liveChild.state);
    assert.equal(child.statusMessage, liveChild.statusMessage);
  });
}

test("a recorded notice can settle a child discovered later through SDK metadata", async () => {
  const rows = await restored([request, notice("completed", "request")]);
  const child = rows.find((row) => row.type === "subagent");
  assert(child?.type === "subagent");
  assert.equal(child.state, "completed");
  assert.equal(child.timeline.length, 2);
  const withoutChild = await restored(
    [request, notice("completed", "request")],
    false,
  );
  assert.equal(withoutChild.filter((row) => row.type === "subagent").length, 0);
});

test("only attributed native headers with a matching target restore a terminal state", async () => {
  const native = notice("completed");
  const body = (native.message as { content: string }).content;
  const variants = [
    { ...native, origin: undefined },
    { ...native, origin: { kind: "human" } },
    {
      ...native,
      origin: { kind: "task-notification", subkind: "scheduled-trigger" },
    },
    { ...native, message: { role: "user", content: "Example: " + body } },
    {
      ...native,
      message: {
        role: "user",
        content: body.replace(
          "<tool-use-id>spawn</tool-use-id>",
          "<tool-use-id>different-call</tool-use-id>",
        ),
      },
    },
    {
      ...native,
      message: {
        role: "user",
        content: body.replace(
          "<task-id>worker</task-id>",
          "<task-id>unknown-worker</task-id>",
        ),
      },
    },
    {
      ...native,
      message: {
        role: "user",
        content: body.replace(
          "<status>completed</status>",
          "<status>running</status>",
        ),
      },
    },
    {
      ...native,
      message: {
        role: "user",
        content:
          "<task-notification><result>" +
          body +
          "</result></task-notification>",
      },
    },
  ];
  for (const variant of variants) {
    const rows = await restored([...launch, variant]);
    const children = rows.filter((row) => row.type === "subagent");
    assert.equal(children.length, 1);
    assert.equal(children[0]!.state, "unknown");
  }
});

test("notification blocks retain the latest reported terminal state without adding user turns", async () => {
  const first = notice("completed");
  const second = notice("stopped", "notice", "notice-2");
  second.message = {
    role: "user",
    content: [
      { type: "text", text: (second.message as { content: string }).content },
    ],
  };
  const rows = await restored([...launch, first, second]);
  const child = rows.find((row) => row.type === "subagent");
  assert(child?.type === "subagent");
  assert.equal(child.state, "interrupted");
  assert.deepEqual(
    child.activities.map((a) => a.state),
    ["running", "completed", "interrupted"],
  );
  assert.deepEqual(
    rows.filter((row) => row.type === "user.message").map((row) => row.id),
    ["request"],
  );
});

test("SDK-discarded notification branches cannot override the selected task outcome", async () => {
  const rows = await restored([
    ...launch,
    notice("failed", "launch-result", "discarded-notice"),
    notice("completed", "launch-result", "selected-notice"),
    {
      type: "assistant",
      uuid: "answer",
      parentUuid: "selected-notice",
      sessionId: key.sessionId,
      message: { role: "assistant", content: [{ type: "text", text: "Done" }] },
    },
  ]);
  const child = rows.find((row) => row.type === "subagent");
  assert(child?.type === "subagent");
  assert.equal(child.state, "completed");
  assert.equal(
    child.activities.some((a) => a.state === "error"),
    false,
  );
});
