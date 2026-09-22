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

test("single and short tool groups expose the actual action directly", () => {
  const html = render([tool("one"), tool("two")]);
  assert.doesNotMatch(html, /<details/);
  assert.match(html, /run-one/);
  assert.match(html, /run-two/);
});

test("only older successes are folded, never running, failed, or selected tools", () => {
  const html = render(
    [
      tool("old"),
      tool("active", "running"),
      tool("failure", "failed"),
      tool("selected"),
      tool("latest-1"),
      tool("latest-2"),
    ],
    "selected",
  );
  const visible = html.replace(/<details[\s\S]*?<\/details>/g, "");
  assert.match(html, /之前 1 项已完成活动/);
  assert.doesNotMatch(visible, /run-old/);
  for (const id of ["active", "failure", "selected", "latest-1", "latest-2"])
    assert.ok(visible.includes(`run-${id}`));
  assert.match(visible, /test assertion failed/);
});
