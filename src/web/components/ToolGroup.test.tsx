import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolGroup } from "./ToolGroup.js";

test("summarizes consecutive commands in a closed details element", () => {
  const html = renderToStaticMarkup(
    <ToolGroup
      onSelectTool={() => undefined}
      rows={[
        {
          type: "tool",
          id: "command-1",
          tool: "command",
          output: "one",
          status: "completed",
        },
        {
          type: "tool",
          id: "command-2",
          tool: "command",
          output: "two",
          status: "completed",
        },
      ]}
    />,
  );

  assert.match(html, /^<details class="tool-group">/);
  assert.match(html, /Ran 2 commands/);
  assert.doesNotMatch(html, /<details[^>]+open/);
  assert.doesNotMatch(html, />one</);
  assert.doesNotMatch(html, />two</);
});
