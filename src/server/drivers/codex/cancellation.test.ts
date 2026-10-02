import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { temporaryImages } from "../../../../test/images.js";
import type { TimelineEvent } from "../../../shared/protocol.js";
import { CodexDriver } from "./codex-driver.js";

for (const scenario of [
  "missing-start-ack",
  "missing-interrupt-terminal",
  "delayed-start-ack",
  "start-error-after-cancel",
] as const) {
  test(
    `Codex cancellation is bounded without replaying a turn: ${scenario}`,
    { timeout: 15_000 },
    async (t) => {
      const directory = await mkdtemp(join(tmpdir(), "racco-cancel-"));
      const previousPath = process.env.PATH;
      process.env.PATH = `${directory}:${previousPath}`;
      const transcript = join(directory, "requests.jsonl");
      const stopped = join(directory, "stopped.json");
      t.after(async () => {
        process.env.PATH = previousPath;
        await rm(directory, { recursive: true, force: true });
      });
      await writeFile(
        join(directory, "codex"),
        String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const lines = require('node:readline').createInterface({ input: process.stdin });
const scenario = ${JSON.stringify(scenario)};
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const turn = { id: 'active-turn', status: 'inProgress', items: [], error: null };
let startRequest, imagePath;
process.on('SIGTERM', () => {
  fs.writeFileSync(${JSON.stringify(stopped)}, JSON.stringify({ imageExists: fs.existsSync(imagePath), pid: process.pid }));
  setTimeout(() => process.exit(0), 50);
});
lines.on('line', line => {
  const message = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(transcript)}, line + '\n');
  if (message.id === undefined) return;
  if (message.method === 'thread/start') return send({ id: message.id, result: { thread: { id: 'root' } } });
  if (message.method === 'turn/start') {
    startRequest = message;
    imagePath = message.params.input.find(part => part.type === 'localImage').path;
    if (scenario === 'missing-interrupt-terminal') send({ id: message.id, result: { turn } });
    send({ method: 'turn/started', params: { threadId: 'root', turn } });
    send({ method: 'item/started', params: { threadId: 'root', turnId: turn.id, item: { type: 'agentMessage', id: 'partial', text: 'Running', phase: 'commentary' } } });
    return;
  }
  if (message.method === 'model/list') {
    if (scenario === 'start-error-after-cancel') {
      send({ id: startRequest.id, error: { code: -32603, message: 'start outcome uncertain' } });
      return send({ id: message.id, result: { data: [], nextCursor: null } });
    }
    // An earlier operation's terminal event cannot confirm this cancellation.
    send({ method: 'turn/completed', params: { threadId: 'root', turn: { ...turn, id: 'old-compaction', status: 'completed' } } });
    send({ id: startRequest.id, result: { turn } });
    return send({ id: message.id, result: { data: [], nextCursor: null } });
  }
  if (message.method === 'turn/interrupt') {
    if (scenario === 'delayed-start-ack') {
      // The matching terminal is sufficient even if the interrupt ACK is lost.
      send({ method: 'turn/completed', params: { threadId: 'root', turn: { ...turn, status: 'interrupted' } } });
    } else send({ id: message.id, result: {} });
    return;
  }
  send({ id: message.id, result: {} });
});
`,
        { mode: 0o700 },
      );

      const images = await temporaryImages();
      const driver = new CodexDriver({ info() {}, warn() {} }, images);
      const events: TimelineEvent[] = [];
      let observedStart!: () => void;
      const started = new Promise<void>((resolve) => {
        observedStart = resolve;
      });
      const controller = new AbortController();
      try {
        await driver.start();
        const modelSettings = { modelId: "test", reasoningEffort: null };
        const handle = await driver.createSession({
          raccoSessionId: "cancel",
          cwd: directory,
          modelSettings,
        });
        const run = driver.runTurn({
          handle,
          mode: "first",
          content: [
            {
              type: "image",
              mediaType: "image/png",
              data: Buffer.from("validated image").toString("base64"),
            },
          ],
          modelSettings,
          signal: controller.signal,
          context: {
            emit(event) {
              events.push(event);
              if (event.type === "assistant.message") observedStart();
            },
            setState() {},
            markProviderMaterialized() {},
            async requestInteraction() {
              throw new Error("Unexpected question");
            },
          },
        });
        void run.catch(() => undefined);
        await started;
        controller.abort();
        if (
          scenario === "delayed-start-ack" ||
          scenario === "start-error-after-cancel"
        ) {
          const release = driver.listModels({
            cwd: directory,
            signal: new AbortController().signal,
          });
          if (scenario === "start-error-after-cancel")
            await release.catch((error) =>
              assert.match(error.message, /cancellation was not confirmed/),
            );
          else await release;
        }
        if (scenario === "delayed-start-ack") {
          await run;
          assert.equal(driver.ready, true);
          assert(!events.some((event) => event.type === "system.notice"));
        } else {
          await assert.rejects(
            run,
            /cancellation was not confirmed|start outcome uncertain/,
          );
          assert.equal(driver.ready, false);
          const proof = JSON.parse(await readFile(stopped, "utf8"));
          assert.equal(
            proof.imageExists,
            true,
            "images remain until native process exit",
          );
          assert.throws(() => process.kill(proof.pid, 0), { code: "ESRCH" });
          assert(
            events.some(
              (event) =>
                event.type === "system.notice" &&
                event.text.includes("其他 Codex 会话"),
            ),
          );
        }
        const requests = (await readFile(transcript, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        const starts = requests.filter(
          (request) => request.method === "turn/start",
        );
        assert.equal(
          starts.length,
          1,
          "never replay a mutation whose outcome is uncertain",
        );
        const interrupts = requests.filter(
          (request) => request.method === "turn/interrupt",
        );
        assert.equal(
          interrupts.length,
          scenario === "missing-start-ack" ||
            scenario === "start-error-after-cancel"
            ? 0
            : 1,
        );
        if (interrupts.length)
          assert.equal(interrupts[0].params.turnId, "active-turn");
        const imagePath = starts[0].params.input[0].path;
        await assert.rejects(stat(imagePath), { code: "ENOENT" });
      } finally {
        await driver.close();
      }
    },
  );
}

test(
  "a failed shared Provider keeps every active turn occupied until native exit",
  { timeout: 15_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "racco-shared-cancel-"));
    const previousPath = process.env.PATH;
    process.env.PATH = `${directory}:${previousPath}`;
    const stopped = join(directory, "stopped.json");
    t.after(async () => {
      process.env.PATH = previousPath;
      await rm(directory, { recursive: true, force: true });
    });
    await writeFile(
      join(directory, "codex"),
      String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const lines = require('node:readline').createInterface({ input: process.stdin });
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const images = [];
let stopping = false;
process.on('SIGTERM', () => {
  if (stopping) return;
  stopping = true;
  fs.writeFileSync(${JSON.stringify(stopped)}, JSON.stringify({ pid: process.pid, images, present: images.map(path => fs.existsSync(path)) }));
  process.stderr.write('shutdown-waiting\n');
  setTimeout(() => process.exit(0), 700);
});
lines.on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === 'thread/start') return send({ id: message.id, result: { thread: { id: message.params.threadSource } } });
  if (message.method === 'turn/start') {
    const threadId = message.params.threadId;
    const turn = { id: threadId + '-turn', status: 'inProgress', items: [], error: null };
    images.push(message.params.input[0].path);
    if (threadId === 'racco:B') send({ id: message.id, result: { turn } });
    send({ method: 'turn/started', params: { threadId, turn } });
    send({ method: 'item/started', params: { threadId, turnId: turn.id, item: { type: 'agentMessage', id: threadId + '-partial', text: 'Running', phase: 'commentary' } } });
    return;
  }
  send({ id: message.id, result: {} });
});
`,
      { mode: 0o700 },
    );
    let observedStopping!: () => void;
    const stopping = new Promise<void>((resolve) => {
      observedStopping = resolve;
    });
    const driver = new CodexDriver(
      {
        info() {},
        warn(data) {
          if ((data as { message?: string }).message === "shutdown-waiting")
            observedStopping();
        },
      },
      await temporaryImages(),
    );
    const modelSettings = { modelId: "test", reasoningEffort: null };
    const controllers = [new AbortController(), new AbortController()];
    const settled = [false, false];
    const runs: Promise<void>[] = [];
    try {
      await driver.start();
      for (const [index, id] of ["A", "B"].entries()) {
        const handle = await driver.createSession({
          raccoSessionId: id,
          cwd: directory,
          modelSettings,
        });
        let observedStart!: () => void;
        const started = new Promise<void>((resolve) => {
          observedStart = resolve;
        });
        const run = driver.runTurn({
          handle,
          mode: "first",
          content: [
            {
              type: "image",
              mediaType: "image/png",
              data: Buffer.from("validated image " + id).toString("base64"),
            },
          ],
          modelSettings,
          signal: controllers[index]!.signal,
          context: {
            emit(event) {
              if (event.type === "assistant.message") observedStart();
            },
            setState() {},
            markProviderMaterialized() {},
            async requestInteraction() {
              throw new Error("Unexpected question");
            },
          },
        });
        void run.then(
          () => {
            settled[index] = true;
          },
          () => {
            settled[index] = true;
          },
        );
        runs.push(run);
        await started;
      }
      controllers[0]!.abort();
      await stopping;
      const proof = JSON.parse(await readFile(stopped, "utf8"));
      assert.doesNotThrow(() => process.kill(proof.pid, 0));
      assert.deepEqual(
        settled,
        [false, false],
        "both executions retain their leases during shared shutdown",
      );
      assert.deepEqual(proof.present, [true, true]);
      assert.equal(controllers[1]!.signal.aborted, false);
      for (const result of await Promise.allSettled(runs))
        assert.equal(result.status, "rejected");
      assert.throws(() => process.kill(proof.pid, 0), { code: "ESRCH" });
      for (const path of proof.images)
        await assert.rejects(stat(path), { code: "ENOENT" });
    } finally {
      await driver.close();
    }
  },
);
