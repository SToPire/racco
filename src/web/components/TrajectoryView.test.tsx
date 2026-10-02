import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { buildTrajectory, type TrajectoryEntry } from "../trajectory.js";
import type { AgentTimelineRow, TimelineRow } from "../store.js";
import {
  TrajectoryInspector,
  TrajectoryResult,
  TrajectoryView,
} from "./TrajectoryView.js";

const entry: TrajectoryEntry = {
  id: "entry-1",
  turn: 2,
  step: 3,
  kind: "tool",
  label: "command",
  summary: "git status",
  actor: "Turing",
  agentPath: "root › reviewer",
  cwd: "/work/project",
  status: "completed",
  payload: { command: "git status" },
  result: "clean",
  raw: { type: "commandExecution" },
};

for (const name of ["reviewer", "Main Agent", undefined]) {
  test(`counts distinct subagents with shared display name ${String(name)}`, () => {
    const children: TimelineRow[] = ["one", "two"].map((agentId) => ({
      type: "subagent",
      id: agentId,
      agentId,
      name,
      state: "running",
      activities: [{ id: `${agentId}-started`, state: "running" }],
      timeline: [
        { type: "assistant.message", id: `${agentId}-answer`, text: "working" },
      ],
    }));
    const html = renderToStaticMarkup(
      <TrajectoryView
        rows={[
          { type: "assistant.message", id: "main", text: "Main message" },
          ...children,
        ]}
      />,
    );
    assert.match(html, /2 子 Agent/);
  });
}

test("renders a searchable trajectory containing every normalized row", () => {
  const html = renderToStaticMarkup(
    <TrajectoryView
      rows={[
        { imageCount: 0, type: "user.message", id: "user", text: "inspect" },
        {
          type: "tool",
          id: "command",
          tool: "command",
          input: { command: "git status" },
          output: "clean",
          status: "completed",
        },
        { type: "assistant.message", id: "assistant", text: "done" },
      ]}
    />,
  );

  assert.match(html, /1 轮/);
  assert.match(html, /1 次调用/);
  assert.match(html, /用户/);
  assert.match(html, /command/);
  assert.match(html, /助手/);
  assert.match(html, /搜索交互/);
});

test("renders clickable interaction details with actor and working directory", () => {
  const html = renderToStaticMarkup(
    <TrajectoryInspector entry={entry} onClose={() => undefined} />,
  );

  assert.match(html, /第 2 轮 · 步骤 3/);
  assert.match(html, /Turing/);
  assert.match(html, /root › reviewer/);
  assert.match(html, /\/work\/project/);
  assert.match(html, /git status/);
});

test("hidden main and child activity stays inspectable without a Chat reveal action", () => {
  const cases: [AgentTimelineRow, boolean][] = [
    [{ type: "assistant.reasoning", id: "activity", summary: [] }, false],
    [{ type: "assistant.reasoning", id: "activity", summary: [" \n "] }, false],
    [{ type: "assistant.plan", id: "activity", text: "" }, false],
    [{ type: "assistant.plan", id: "activity", text: " \n " }, false],
    [
      {
        type: "assistant.reasoning",
        id: "activity",
        summary: [],
        partial: true,
      },
      true,
    ],
    [
      { type: "assistant.plan", id: "activity", text: " ", partial: true },
      true,
    ],
    [
      { type: "assistant.reasoning", id: "activity", summary: ["Checking"] },
      true,
    ],
    [{ type: "assistant.plan", id: "activity", text: "Run checks" }, true],
  ];
  for (const [activity, visible] of cases) {
    for (const agentId of [undefined, "child"]) {
      const rows: TimelineRow[] =
        agentId === undefined
          ? [activity]
          : [
              {
                type: "subagent",
                id: "subagent:child",
                agentId,
                state: "running",
                prompt: "Check layout",
                activities: [{ id: "start", state: "running" }],
                timeline: [activity],
              },
            ];
      const entries = buildTrajectory(rows);
      const projected = entries.find((entry) => entry.kind === "assistant")!;
      assert.deepEqual(projected.raw, activity);
      assert.equal(projected.agentId, agentId);
      assert.equal(projected.rowId, visible ? activity.id : undefined);
      for (const entry of entries) {
        const html = renderToStaticMarkup(
          <TrajectoryInspector
            entry={entry}
            onClose={() => undefined}
            onReveal={() => undefined}
          />,
        );
        // Synthetic child task/state entries still navigate to the child Chat.
        assert.equal(
          html.includes("在对话中查看"),
          entry.kind === "assistant" ? visible : true,
        );
      }
    }
  }
});

test("renders tool results as literal preformatted output", () => {
  const output = "# source heading\n- source item\n  const value = 1;";
  const html = renderToStaticMarkup(
    <TrajectoryResult entry={{ ...entry, result: output }} />,
  );

  assert.match(html, /^<pre>/);
  assert.match(html, /# source heading\n- source item\n  const value = 1;/);
  assert.doesNotMatch(html, /<h1>|<li>/);
});

test("continues to render assistant results as Markdown", () => {
  const html = renderToStaticMarkup(
    <TrajectoryResult
      entry={{
        ...entry,
        kind: "assistant",
        label: "Assistant",
        result: "# Heading",
      }}
    />,
  );

  assert.match(html, /<h1>Heading<\/h1>/);
});
