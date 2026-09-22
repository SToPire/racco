import assert from "node:assert/strict";
import test from "node:test";
import { buildTimeline } from "../../../web/store.js";
import { describeTool } from "../../../web/tool-presentation.js";
import { parseUnifiedDiff } from "../../../shared/file-diff.js";
import { mapItemEvents } from "./event-mapper.js";
import { mapFileChange } from "./file-change.js";
import type { CodexFileChange, CodexThreadItem } from "./types.js";

test("native Codex file content has the same addition/deletion facts through the timeline and summary", () => {
  const cases: Array<["add" | "delete", string, string | undefined]> = [
    ["add", "hello\n", "+1 −0"],
    ["delete", "hello\n", "+0 −1"],
    ["add", "- checklist item\n", "+1 −0"],
    ["delete", "+ literal plus\n", "+0 −1"],
    ["add", "++counter;\n--counter;\n", "+2 −0"],
    ["add", "@@ -1 +1 @@\n-example\n+example\n", "+3 −0"],
    ["add", "", undefined],
    ["delete", "", undefined],
    ["add", "\n", "+1 −0"],
    ["add", "one\n\n", "+2 −0"],
    ["delete", "one\r\ntwo\r\n", "+0 −2"],
    ["add", "no newline", "+1 −0"],
  ];
  for (const [type, content, outcome] of cases) {
    const item: CodexThreadItem = {
      type: "fileChange",
      id: "change",
      status: "completed",
      changes: [{ path: "README.md", kind: { type }, diff: content }],
    };
    const [row] = buildTimeline(mapItemEvents(item, () => "unused"));
    assert(row?.type === "tool");
    assert.equal(
      describeTool(row).outcome,
      outcome,
      `${type}: ${JSON.stringify(content)}`,
    );
    assert.equal(
      row.details,
      item,
      "raw native item remains available without mutation",
    );
    assert.equal(item.changes[0]!.diff, content);
  }
});

test("normalization preserves missing newline and keeps update patches and rename data intact", () => {
  assert.equal(
    mapFileChange({ path: "a", kind: { type: "add" }, diff: "text" }).diff,
    "@@ -0,0 +1,1 @@\n+text\n\\ No newline at end of file",
  );
  assert.equal(
    mapFileChange({ path: "a", kind: { type: "delete" }, diff: "text\n" }).diff,
    "@@ -1,1 +0,0 @@\n-text\n",
  );
  const change: CodexFileChange = {
    path: "a",
    kind: { type: "update", move_path: "b" },
    diff: "@@ -1 +1 @@\n---counter;\n+++counter;\n\nMoved to: b",
  };
  assert.deepEqual(mapFileChange(change), change);
  const lines = parseUnifiedDiff(mapFileChange(change).diff);
  assert.equal(lines.filter((line) => line.kind === "added").length, 1);
  assert.equal(lines.filter((line) => line.kind === "removed").length, 1);
});
