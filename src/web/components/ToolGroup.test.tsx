import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolGroup } from "./ToolGroup.js";
import type { ToolTimelineRow } from "../store.js";
const tool = (
  id: string,
  status: ToolTimelineRow["status"] = "completed",
): ToolTimelineRow => ({
  type: "tool",
  id,
  tool: "command",
  input: { command: `run-${id}` },
  output: status === "failed" ? "test assertion failed" : "",
  status,
});
const render = (rows: ToolTimelineRow[], selectedToolId?: string) =>
  renderToStaticMarkup(
    <ToolGroup
      rows={rows}
      selectedToolId={selectedToolId}
      onSelectTool={() => undefined}
    />,
  );

const rowIds = (html: string) =>
  [...html.matchAll(/data-timeline-row="([^"]+)"/g)].map((match) => match[1]);
const history = (html: string) =>
  html.match(/<details[\s\S]*?<\/details>/)?.[0] ?? "";
const recent = (html: string) =>
  html.replace(/<details[\s\S]*?<\/details>/g, "");

test("up to three tools expose every action in timeline order", () => {
  const rows = [tool("one", "failed"), tool("two"), tool("three", "running")];
  for (let count = 0; count <= rows.length; count++) {
    const group = rows.slice(0, count);
    const html = render(group);
    assert.doesNotMatch(html, /<details/);
    assert.deepEqual(
      rowIds(html),
      group.map((row) => row.id),
    );
    for (const row of group) assert.ok(html.includes(`run-${row.id}`));
  }
});

test("four tools fold the chronological prefix, including a failure before a success", () => {
  const html = render([tool("a", "failed"), tool("b"), tool("c"), tool("d")]);
  assert.deepEqual(rowIds(html), ["a", "b", "c", "d"]);
  assert.deepEqual(rowIds(history(html)), ["a", "b"]);
  assert.deepEqual(rowIds(recent(html)), ["c", "d"]);
  assert.match(history(html), /较早 2 项 · command 2/);
  assert.doesNotMatch(
    history(html),
    /<summary>[\s\S]*已完成[\s\S]*<\/summary>/,
  );
  assert.match(history(html), /test assertion failed/);
});

test("selection and every tool status keep older rows in one continuous history", () => {
  const rows = [
    tool("failure", "failed"),
    tool("old"),
    tool("active", "running"),
    tool("stopped", "interrupted"),
    tool("unknown", "incomplete"),
    tool("latest-1"),
    tool("latest-2"),
  ];
  for (const selectedToolId of [undefined, ...rows.map((row) => row.id)]) {
    const html = render(rows, selectedToolId);
    assert.deepEqual(
      rowIds(html),
      rows.map((row) => row.id),
    );
    assert.deepEqual(rowIds(history(html)), [
      "failure",
      "old",
      "active",
      "stopped",
      "unknown",
    ]);
    assert.deepEqual(rowIds(recent(html)), ["latest-1", "latest-2"]);
    assert.match(history(html), /较早 5 项 · command 5/);
    assert.match(history(html), /运行中/);
    assert.match(history(html), /已中断/);
    assert.match(history(html), /结果未知/);
    if (selectedToolId) {
      assert.ok(
        html.includes(
          `aria-pressed="true" data-timeline-row="${selectedToolId}"`,
        ),
      );
    }
  }
});

test("status updates leave the history boundary and timeline order unchanged", () => {
  const statuses: ToolTimelineRow["status"][] = [
    "running",
    "completed",
    "failed",
    "interrupted",
    "incomplete",
  ];
  for (const status of statuses) {
    const html = render(
      [tool("a", status), tool("b"), tool("c"), tool("d", status)],
      "b",
    );
    assert.deepEqual(rowIds(html), ["a", "b", "c", "d"]);
    assert.deepEqual(rowIds(history(html)), ["a", "b"]);
    assert.deepEqual(rowIds(recent(html)), ["c", "d"]);
    assert.match(history(html), /较早 2 项/);
  }
});
