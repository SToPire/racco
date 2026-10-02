import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { installFakeCodex } from "../../../../test/fixtures/codex-peer.js";
import { CodexAppServerClient } from "./app-server-client.js";
import { validateCodexHandshake } from "./contract.js";
import { mapItemEvents, mapThreadEvents } from "./event-mapper.js";
import { buildTimeline } from "../../../web/store.js";
import type { CodexThread } from "./types.js";

test("the captured native shell transcript maps a real completed command and its output", async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL(
        "../../../../test/fixtures/codex/0.160.0-shell-transcript.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const received = fixture.trace
    .filter((entry: { direction: string }) => entry.direction === "received")
    .map((entry: { message: Record<string, unknown> }) => entry.message);
  validateCodexHandshake(
    received.find((m: { id: number }) => m.id === 1).result,
  );
  const thread = received.find((m: { id: number }) => m.id === 4).result
    .thread as CodexThread;
  assert.equal(thread.turns.at(-1)?.status, "completed");
  assert.deepEqual(
    mapThreadEvents(thread, () => undefined),
    [],
  );
  const completed = received.find(
    (m: { method: string }) => m.method === "item/completed",
  );
  const tool = buildTimeline(
    mapItemEvents(completed.params.item, () => undefined, "completed"),
  ).find((row) => row.type === "tool");
  assert(tool?.type === "tool");
  assert.equal(tool.tool, "command");
  assert.equal(tool.status, "completed");
  assert.equal(tool.output, "racco-contract-smoke");
  assert(
    received.some(
      (m: { method: string }) =>
        m.method === "item/commandExecution/outputDelta",
    ),
  );
});

test("unsupported native versions fail before any session mutation and close the real child", async (t) => {
  const peer = await installFakeCodex(t, {
    script: `export const handlers={initialize:()=>({userAgent:'racco/0.159.3 Linux',codexHome:'/tmp/test',platformFamily:'unix',platformOs:'linux'})};`,
  });
  const client = new CodexAppServerClient(
    { info() {}, warn() {} },
    async () => ({}),
  );
  t.after(() => client.close());
  let closed = false;
  client.onProcessExit(() => {
    closed = true;
  });
  await assert.rejects(client.start(), /install @openai\/codex@0.160.0/);
  assert.equal(closed, true);
  assert.deepEqual(
    (await peer.requests()).map((x) => x.method),
    ["initialize"],
  );
});
