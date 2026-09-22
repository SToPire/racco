import assert from "node:assert/strict";
import test from "node:test";
import type { TimelineRow } from "./store.js";
import { buildTrajectory } from "./trajectory.js";

test("projects main and subagent interactions into one session trajectory", () => {
  const rows: TimelineRow[] = [
    { type: "user.message", id: "user-1", text: "delegate this" },
    {
      type: "tool",
      id: "root-command",
      tool: "command",
      input: { command: "pwd" },
      output: "/work/project",
      status: "completed",
    },
    {
      type: "subagent",
      id: "subagent:agent-1",
      agentId: "agent-1",
      name: "Turing",
      agentPath: "/root/reviewer",
      cwd: "/work/project",
      prompt: "review it",
      state: "completed",
      activities: [
        { id: "started", state: "starting" },
        { id: "completed", state: "completed" },
      ],
      timeline: [
        {
          type: "tool",
          id: "child-command",
          tool: "command",
          input: { command: "git diff" },
          output: "diff",
          status: "completed",
        },
        {
          type: "assistant.message",
          id: "child-answer",
          text: "looks good",
        },
      ],
    },
    { type: "assistant.message", id: "root-answer", text: "done" },
  ];

  const entries = buildTrajectory(rows);
  assert.deepEqual(
    entries.map((entry) => [entry.kind, entry.label, entry.actor]),
    [
      ["user", "User", "Main Agent"],
      ["tool", "command", "Main Agent"],
      ["subagent", "Subagent", "Turing"],
      ["user", "Task", "Turing"],
      ["subagent", "Agent state", "Turing"],
      ["subagent", "Agent state", "Turing"],
      ["tool", "command", "Turing"],
      ["assistant", "Assistant", "Turing"],
      ["assistant", "Assistant", "Main Agent"],
    ],
  );
  assert.equal(
    entries
      .filter((entry) => entry.agentId === undefined)
      .every((entry) => entry.turn === 1),
    true,
  );
  assert.equal(
    entries
      .filter((entry) => entry.agentId === "agent-1")
      .every((entry) => entry.turn === undefined),
    true,
  );
  assert.equal(entries[6]?.rowId, "child-command");
  assert.equal(entries.at(-1)?.step, 3);
  assert.equal(entries[6]?.cwd, "/work/project");
  assert.equal(entries[6]?.agentPath, "root › reviewer");
});
