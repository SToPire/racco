import assert from "node:assert/strict";
import test from "node:test";
import type {
  BashOutput,
  FileEditOutput,
  FileWriteOutput,
} from "@anthropic-ai/claude-agent-sdk/sdk-tools";
import { claudeToolResultFacts } from "./tool-facts.js";

test("keeps native background task identity for the activity summary", () => {
  const result: BashOutput = {
    stdout: "error is a search term here",
    stderr: "warning text",
    interrupted: true,
    backgroundTaskId: "task-1",
    timedOutAfterMs: 1500,
    persistedOutputPath: "/work/tool-results/full.txt",
    persistedOutputSize: 3000,
  };
  const view = claudeToolResultFacts(result);
  assert.deepEqual(view, { backgroundTaskId: "task-1" });
});

test("uses recorded Edit hunks without rebuilding a diff from strings", () => {
  const result: FileEditOutput = {
    filePath: "/work/app.ts",
    oldString: "old",
    newString: "new",
    originalFile: "old",
    structuredPatch: [
      {
        oldStart: 20,
        oldLines: 1,
        newStart: 20,
        newLines: 2,
        lines: ["-old", "+new", "+extra"],
      },
    ],
    userModified: false,
    replaceAll: false,
  };
  const view = claudeToolResultFacts(result);
  assert.deepEqual(view.fileChanges?.[0], {
    path: "/work/app.ts",
    kind: { type: "update", move_path: null },
    diff: "@@ -20,1 +20,2 @@\n-old\n+new\n+extra",
  });
});

test("an empty Write patch does not claim the file was unchanged", () => {
  const result: FileWriteOutput = {
    type: "update",
    filePath: "/work/large.txt",
    content: "replacement",
    structuredPatch: [],
    originalFile: null,
  };
  const view = claudeToolResultFacts(result);
  assert.equal(view.fileChanges?.[0]?.path, "/work/large.txt");
  assert.equal(view.fileChanges?.[0]?.diff, "");
});

test("does not invent facts from malformed or missing native results", () => {
  assert.deepEqual(
    claudeToolResultFacts({
      filePath: "/work/app.ts",
      structuredPatch: [{ lines: ["+text"] }],
    }),
    {},
  );
  assert.deepEqual(claudeToolResultFacts(undefined), {});
  assert.deepEqual(claudeToolResultFacts({ filePath: "/work/app.ts" }), {});
});
