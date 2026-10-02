import assert from "node:assert/strict";
import test from "node:test";
import { codexToolFacts } from "./tool-facts.js";
import {
  claudeToolInputFacts,
  claudeToolResultFacts,
} from "../claude/tool-facts.js";
import type { CodexThreadItem } from "./types.js";

const command: Extract<CodexThreadItem, { type: "commandExecution" }> = {
  type: "commandExecution",
  id: "cmd",
  command: "npm test",
  cwd: "/work",
  status: "completed",
  commandActions: [],
  aggregatedOutput: "done",
  exitCode: 0,
  durationMs: 1300,
  processId: null,
  source: "agent",
  pluginId: null,
  scriptPath: null,
};

test("Codex command actions become shared summaries without guessing shell intent", () => {
  assert.deepEqual(codexToolFacts(command), {
    summary: "npm test",
    command: "npm test",
    cwd: "/work",
    exitCode: 0,
    durationMs: 1300,
  });
  assert.equal(
    codexToolFacts({
      ...command,
      commandActions: [
        { type: "read", path: "main.ts", name: "main", command: "cat main.ts" },
      ],
    }).summary,
    "read main.ts",
  );
  assert.equal(
    codexToolFacts({
      ...command,
      commandActions: [
        {
          type: "search",
          path: "src/",
          query: "tool.started",
          command: "rg tool.started src/",
        },
      ],
    }).summary,
    "search tool.started · src/",
  );
  assert.equal(
    codexToolFacts({
      ...command,
      commandActions: [{ type: "unknown", command: "something" }],
    }).summary,
    "npm test",
  );
  assert.equal(
    codexToolFacts({ ...command, exitCode: null, durationMs: null }).exitCode,
    undefined,
  );
});

test("both providers map equivalent command and patch facts, with absent facts left unknown", () => {
  const codex = codexToolFacts(command);
  const claude = claudeToolInputFacts("Bash", { command: "npm test" });
  assert.equal(codex.command, claude.command);
  assert.equal(codex.summary, claude.summary);
  assert.equal(claude.exitCode, undefined);
  assert.deepEqual(
    codexToolFacts({
      type: "fileChange",
      id: "file",
      status: "completed",
      changes: [
        {
          path: "app.ts",
          kind: { type: "update", move_path: null },
          diff: "@@ -1,1 +1,2 @@\n-old\n+new\n+extra",
        },
      ],
    }),
    claudeToolResultFacts({
      filePath: "app.ts",
      structuredPatch: [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 2,
          lines: ["-old", "+new", "+extra"],
        },
      ],
    }),
  );
  assert.deepEqual(
    claudeToolInputFacts("Edit", {
      file_path: "app.ts",
      old_string: "private text",
    }),
    { summary: "app.ts" },
  );
  assert.deepEqual(
    claudeToolInputFacts("Grep", { pattern: "needle", path: "src" }),
    { summary: "needle · src" },
  );
});

test("Codex web summaries preserve page actions and all search queries", () => {
  const cases: Array<
    [Extract<CodexThreadItem, { type: "webSearch" }>["action"], string]
  > = [
    [{ type: "search", query: null, queries: ["北京", "上海"] }, "北京、上海"],
    [{ type: "search", query: "深圳", queries: null }, "深圳"],
    [{ type: "openPage", url: "https://example.com" }, "https://example.com"],
    [
      { type: "findInPage", url: "https://example.com", pattern: "温度" },
      "温度 · https://example.com",
    ],
    [{ type: "other" }, "网页操作"],
  ];
  for (const [action, summary] of cases)
    assert.equal(
      codexToolFacts({
        type: "webSearch",
        id: "web",
        query: "",
        action,
        results: null,
      }).summary,
      summary,
    );
});
