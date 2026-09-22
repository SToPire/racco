import assert from "node:assert/strict";
import test from "node:test";
import { parseUnifiedDiff } from "./file-diff.js";

test("file headers are distinct from increment and decrement lines inside a hunk", () => {
  const lines = parseUnifiedDiff(
    "--- a/counter.ts\n+++ b/counter.ts\n@@ -1 +1 @@\n---counter;\n+++counter;",
  );
  assert.deepEqual(
    lines.map((line) => line.kind),
    ["context", "context", "hunk", "removed", "added"],
  );
});

test("counts explicit ranges, blank changes and no-newline markers without counting metadata", () => {
  const lines = parseUnifiedDiff(
    "@@ -0,0 +1,3 @@\n+first\n+\n+++counter;\n\\ No newline at end of file\n--- a/second\n+++ b/second\n@@ -4,2 +7,0 @@ function\n---counter;\n-\n\\ No newline at end of file\nMoved to: next.ts",
  );
  assert.equal(lines.filter((line) => line.kind === "added").length, 3);
  assert.equal(lines.filter((line) => line.kind === "removed").length, 2);
  assert.equal(lines.at(-1)?.kind, "context");
});

test("context and multiple hunks consume only their own declared ranges", () => {
  const lines = parseUnifiedDiff(
    "@@ -1,2 +1,2 @@\n unchanged\n-old\n+new\n+++ another file header\n@@ -8 +8,2 @@\n-context\n+replacement\n+extra",
  );
  assert.deepEqual(
    lines.filter((line) => line.kind === "added").map((line) => line.text),
    ["+new", "+replacement", "+extra"],
  );
  assert.equal(lines.filter((line) => line.kind === "removed").length, 2);
});
