import { installFakeCodex } from "../../../../test/fixtures/codex-peer.js";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { temporaryImages } from "../../../../test/images.js";
import { CodexAppServerClient } from "./app-server-client.js";
import { CodexDriver } from "./codex-driver.js";

test(
  "fails pending requests and stops the provider on invalid RPC output",
  { timeout: 10_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "racco-rpc-test-"));
    const previousExecutablePath = process.env.PATH;
    assert(previousExecutablePath !== undefined);
    process.env.PATH = `${directory}:${previousExecutablePath}`;
    t.after(async () => {
      process.env.PATH = previousExecutablePath;
      await rm(directory, { recursive: true, force: true });
    });

    for (const output of [
      "not-json",
      "[]",
      '{"unexpected":true}',
      '{"id":1,"error":null}',
      '{"id":"question","method":"item/tool/requestUserInput"}\nnot-json',
    ]) {
      await writeFile(
        join(directory, "codex"),
        `#!/usr/bin/env node
process.stdin.once("data", () => process.stdout.write(${JSON.stringify(output + "\n")}));
setInterval(() => {}, 1000);
`,
        { mode: 0o700 },
      );
      const exits: Error[] = [];
      let rejectInteraction: ((error: Error) => void) | undefined;
      const client = new CodexAppServerClient(
        { info() {}, warn() {} },
        () =>
          new Promise((_resolve, reject) => {
            rejectInteraction = reject;
          }),
      );
      client.onExit((error) => exits.push(error));
      try {
        await assert.rejects(client.start(), /Invalid Codex app-server/);
        assert.equal(exits.length, 1);
        await assert.rejects(
          client.request("thread/read", {}),
          /has not started/,
        );
        rejectInteraction?.(new Error("Provider exited"));
        await new Promise<void>((resolve) => setImmediate(resolve));
      } finally {
        await client.close();
      }
    }
  },
);

async function fakeCodex(t: TestContext, source: string): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "racco-rpc-fault-"));
  const previousPath = process.env.PATH;
  process.env.PATH = `${directory}:${previousPath}`;
  t.after(async () => {
    process.env.PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(join(directory, "codex"), source, { mode: 0o700 });
}

test(
  "a broken native input pipe fails the provider without crashing the host",
  { timeout: 10_000 },
  async (t) => {
    await fakeCodex(
      t,
      String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const lines = require('node:readline').createInterface({ input: process.stdin });
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
lines.on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') send({ id: message.id, result: {} });
  if (message.method === 'break-input') {
    lines.close();
    fs.closeSync(0);
    send({ method: 'input-closed' });
  }
});
setInterval(() => {}, 1000);
`,
    );
    const client = new CodexAppServerClient(
      { info() {}, warn() {} },
      async () => ({}),
    );
    const exits: Error[] = [];
    client.onExit((error) => exits.push(error));
    const inputClosed = new Promise<void>((resolve) =>
      client.onNotification(() => resolve()),
    );
    const processClosed = new Promise<void>((resolve) =>
      client.onProcessExit(resolve),
    );
    try {
      await client.start();
      const pending = assert.rejects(client.request("break-input"), /EPIPE/);
      await inputClosed;
      await assert.rejects(client.request("after-close"), /EPIPE/);
      await pending;
      await processClosed;
      assert.equal(exits.length, 1);
      await assert.rejects(client.request("thread/read"), /has not started/);
    } finally {
      await client.close();
    }
  },
);

test(
  "a malformed native notification fails an actual driver and its pending RPC",
  { timeout: 10_000 },
  async (t) => {
    await fakeCodex(
      t,
      String.raw`#!/usr/bin/env node
const lines = require('node:readline').createInterface({ input: process.stdin });
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
lines.on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') send({ id: message.id, result: {} });
  if (message.method === 'thread/start') send({ method: 'thread/started', params: {} });
});
`,
    );
    const driver = new CodexDriver(
      { info() {}, warn() {} },
      await temporaryImages(),
    );
    try {
      await driver.start();
      await assert.rejects(
        driver.createSession({
          raccoSessionId: "malformed-notification",
          cwd: process.cwd(),
          modelSettings: { modelId: "test", reasoningEffort: null },
        }),
        /Invalid Codex app-server message/,
      );
      assert.equal(driver.ready, false);
    } finally {
      await driver.close();
    }
  },
);

test(
  "RPC deadlines keep reads local and close uncertain mutations without replay",
  { timeout: 10_000 },
  async (t) => {
    await fakeCodex(
      t,
      String.raw`#!/usr/bin/env node
const lines = require('node:readline').createInterface({ input: process.stdin });
lines.on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') process.stdout.write(JSON.stringify({id:message.id,result:{}})+'\n');
});
`,
    );
    const client = new CodexAppServerClient(
      { info() {}, warn() {} },
      async () => ({}),
      { initializeMs: 1000, requestMs: 40 },
    );
    t.after(() => client.close());
    await client.start();
    let closed = false;
    client.onProcessExit(() => {
      closed = true;
    });
    await assert.rejects(client.request("thread/read"), /timed out$/);
    assert.equal(closed, false);
    const controller = new AbortController();
    const read = client.request("thread/read", {}, controller.signal);
    controller.abort(new Error("Read cancelled"));
    await assert.rejects(read, /Read cancelled/);
    await assert.rejects(
      client.request("thread/start"),
      /result unconfirmed; the request was not replayed/,
    );
    assert.equal(closed, true);
    await assert.rejects(client.request("thread/start"), /has not started/);
  },
);
test("strict Codex peer rejects undeclared RPCs and schedules notifications around replies", async (t) => {
  const peer = await installFakeCodex(t, {
    script: `
export const handlers = {
  initialize: () => ({}),
  ordered: (_, { notify, afterReply }) => {
    notify('fixture/before', {});
    afterReply(() => notify('fixture/after', {}));
    return { accepted: true };
  },
};`,
  });
  const client = new CodexAppServerClient(
    { info() {}, warn() {} },
    async () => ({}),
  );
  const notifications: string[] = [];
  let after!: () => void;
  const completed = new Promise<void>((resolve) => {
    after = resolve;
  });
  client.onNotification((message) => {
    notifications.push(message.method);
    if (message.method === "fixture/after") after();
  });
  try {
    await client.start();
    await assert.rejects(
      client.request("typo/method"),
      /Unexpected fixture RPC: typo\/method/,
    );
    assert.deepEqual(await client.request("ordered"), { accepted: true });
    await completed;
    assert.deepEqual(notifications, ["fixture/before", "fixture/after"]);
    assert.deepEqual(
      (await peer.requests())
        .filter((request) => request.method !== "initialized")
        .map((request) => request.method),
      ["initialize", "typo/method", "ordered"],
    );
  } finally {
    await client.close();
  }
});
