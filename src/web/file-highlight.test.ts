import assert from "node:assert/strict";
import test from "node:test";
import { highlightFile } from "./file-highlight.js";

test("highlighted HTML is escaped and cannot introduce executable markup", () => {
  const result = highlightFile(
    "example.html",
    '<script>alert("x")</script><img src="x" onerror="alert(1)">',
  );
  assert.ok(result);
  assert.doesNotMatch(result.html, /<script|<img|<iframe/);
  assert.match(result.html, /&lt;/);
});

test("unknown languages and large files remain plain text", () => {
  assert.equal(highlightFile("unknown.data", "hello"), undefined);
  assert.equal(highlightFile("large.ts", "x".repeat(100_001)), undefined);
});
