import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { TrajectoryEntry } from "../trajectory.js";
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
  label: "Bash",
  summary: "git status",
  actor: "Turing",
  agentPath: "root › reviewer",
  cwd: "/work/project",
  status: "completed",
  payload: { command: "git status" },
  result: "clean",
  raw: { type: "commandExecution" },
};

test("renders a searchable trajectory containing every normalized row", () => {
  const html = renderToStaticMarkup(
    <TrajectoryView
      rows={[
        { type: "user.message", id: "user", text: "inspect" },
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

  assert.match(html, /1 Turns/);
  assert.match(html, /1 Calls/);
  assert.match(html, /USER/);
  assert.match(html, /Bash/);
  assert.match(html, /ASSISTANT/);
  assert.match(html, /Search/);
});

test("renders clickable interaction details with actor and working directory", () => {
  const html = renderToStaticMarkup(
    <TrajectoryInspector entry={entry} onClose={() => undefined} />,
  );

  assert.match(html, /Turn 2 · Step 3/);
  assert.match(html, /Turing/);
  assert.match(html, /root › reviewer/);
  assert.match(html, /\/work\/project/);
  assert.match(html, /git status/);
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
