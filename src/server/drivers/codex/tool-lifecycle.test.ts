import assert from "node:assert/strict";
import test from "node:test";
import { CodexToolLifecycle } from "./tool-lifecycle.js";

test("settles only unfinished calls in the addressed thread and turn", () => {
  const lifecycle = new CodexToolLifecycle();
  const started = (id: string) => ({
    type: "tool.started" as const,
    id,
    tool: "command",
    input: {},
  });
  lifecycle.observe("main", "first", [
    started("pending"),
    started("background-launch"),
    { type: "tool.completed", id: "background-launch", status: "completed" },
  ]);
  lifecycle.observe("main", "next", [started("next-call")]);
  lifecycle.observe("child", "first", [started("pending")]);
  assert.deepEqual(lifecycle.finish("main", "interrupted", "first"), [
    { type: "tool.completed", id: "pending", status: "interrupted" },
  ]);
  assert.deepEqual(lifecycle.finish("main", "incomplete"), [
    { type: "tool.completed", id: "next-call", status: "incomplete" },
  ]);
  assert.deepEqual(lifecycle.finish("child", "failed"), [
    { type: "tool.completed", id: "pending", status: "failed" },
  ]);
  assert.deepEqual(lifecycle.finish("main", "failed"), []);
  lifecycle.clear();
});
