import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexDriver } from "./codex-driver.js";
import type { ContextUsage, TimelineEvent } from "../../../shared/protocol.js";
import type { DriverContext } from "../driver.js";

test(
  "Codex sends explicit model and effort on every turn including after thread resume",
  { timeout: 10_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "racco-model-wire-"));
    const transcript = join(directory, "requests.jsonl");
    const previousPath = process.env.PATH;
    process.env.PATH = `${directory}:${previousPath}`;
    t.after(async () => {
      process.env.PATH = previousPath;
      await rm(directory, { recursive: true, force: true });
    });
    await writeFile(
      join(directory, "codex"),
      `#!/usr/bin/env node
const fs = require('node:fs');
const lines = require('node:readline').createInterface({ input: process.stdin });
let turns = 0;
const send = message => process.stdout.write(JSON.stringify(message) + '\\n');
lines.on('line', line => {
  const message = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(transcript)}, line + '\\n');
  if (message.id === undefined) return;
  let result = {};
  if (message.method === 'thread/start') result = { thread: { id: 'native-test', cwd: message.params.cwd } };
  if (message.method === 'turn/start') {
    const turn = { id: 'turn-' + (++turns), status: 'completed', items: [], error: null };
    // A previous native compaction ends before turn/start acknowledges this message.
    send({ method: 'turn/completed', params: { threadId: message.params.threadId, turn: { ...turn, id: 'previous-compact', status: 'failed', error: { message: 'old failure' } } } });
    result = { turn };
    // Exercise both orders of the real completion and the RPC response.
    const completed = () => send({ method: 'turn/completed', params: { threadId: message.params.threadId, turn } });
    if (message.params.effort === 'low') completed(); else setTimeout(completed, 15);
  }
  send({ id: message.id, result });
});
`,
      { mode: 0o700 },
    );
    const log = { info() {}, warn() {} };
    const context: DriverContext = {
      emit() {},
      setState() {},
      markProviderMaterialized() {},
      async requestInteraction() {
        throw new Error("Unexpected user input request");
      },
    };
    const first = new CodexDriver(log);
    const resumed = new CodexDriver(log);
    try {
      await first.start();
      const settings = { modelId: "native-model-a", reasoningEffort: "xhigh" };
      const handle = await first.createSession({
        raccoSessionId: "racco",
        cwd: process.cwd(),
        modelSettings: settings,
      });
      await first.runTurn({
        handle,
        mode: "first",
        prompt: "first",
        modelSettings: settings,
        context,
        signal: new AbortController().signal,
      });
      await first.close();
      await resumed.start();
      await resumed.runTurn({
        handle,
        mode: "resume",
        prompt: "next",
        modelSettings: { modelId: "native-model-b", reasoningEffort: "low" },
        context,
        signal: new AbortController().signal,
      });
      const requests = (await readFile(transcript, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.deepEqual(
        requests
          .filter((request) => request.method === "turn/start")
          .map((request) => [request.params.model, request.params.effort]),
        [
          ["native-model-a", "xhigh"],
          ["native-model-b", "low"],
        ],
      );
      const resume = requests.find(
        (request) => request.method === "thread/resume",
      ).params;
      for (const request of requests.filter((request) =>
        ["thread/start", "thread/resume"].includes(request.method),
      )) {
        assert.equal(request.params.approvalPolicy, "never");
        assert.equal(request.params.sandbox, "danger-full-access");
      }
      assert.equal(resume.threadId, "native-test");
      assert.equal(resume.model, "native-model-b");
      assert.equal(resume.config.model_reasoning_effort, "low");
    } finally {
      await first.close();
      await resumed.close();
    }
  },
);

test(
  "Codex tracks compaction through native completion, early events, failures and process exit",
  { timeout: 10000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "racco-compact-wire-"));
    const transcript = join(directory, "requests.jsonl");
    const previousPath = process.env.PATH;
    process.env.PATH = `${directory}:${previousPath}`;
    t.after(async () => {
      process.env.PATH = previousPath;
      await rm(directory, { recursive: true, force: true });
    });
    await writeFile(
      join(directory, "codex"),
      `#!/usr/bin/env node
const fs = require('node:fs');
const lines = require('node:readline').createInterface({ input: process.stdin });
const send = message => process.stdout.write(JSON.stringify(message) + '\\n');
lines.on('line', line => {
  const message = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(transcript)}, line + '\\n');
  if (message.id === undefined) return;
  const threadId = message.params?.threadId;
  if (message.method === 'thread/compact/start') {
    const completed = (id = threadId) => send({ method: 'turn/completed', params: { threadId: id, turn: { id: 'compact', status: 'completed', items: [], error: null } } });
    if (threadId === 'early') {
      completed();
      send({ id: message.id, result: {} });
      return;
    }
    if (threadId === 'disconnect') {
      send({ id: message.id, result: {} });
      setTimeout(() => process.exit(1), 50);
      return;
    }
    if (threadId === 'rpc-failure') {
      send({ id: message.id, error: { code: -32000, message: 'cannot compact' } });
      return;
    }
    send({ method: 'turn/started', params: { threadId, turn: { id: 'compact', status: 'inProgress', items: [], error: null } } });
    completed('child');
    setTimeout(() => {
      if (threadId === 'async-failure') {
        send({ method: 'error', params: { threadId, turnId: 'compact', willRetry: false, error: { message: 'compaction failed' } } });
      } else {
        send({ method: 'thread/tokenUsage/updated', params: { threadId, turnId: 'compact', tokenUsage: {
          last: { totalTokens: 12000 }, total: { totalTokens: 9999999 }, modelContextWindow: 272000
        } } });
        send({ method: 'item/completed', params: { threadId, turnId: 'compact', item: { type: 'contextCompaction', id: 'compacted' } } });
        setTimeout(() => completed(), 50);
      }
    }, 100);
  }
  send({ id: message.id, result: {} });
});
`,
      { mode: 0o700 },
    );
    const usages: ContextUsage[] = [];
    const events: TimelineEvent[] = [];
    const finished: string[] = [];
    const driver = new CodexDriver({ info() {}, warn() {} });
    let changed!: () => void;
    let nextUpdate = new Promise<void>((resolve) => {
      changed = resolve;
    });
    driver.onSessionUpdate((id, update) => {
      if (update.type === "context.usage") usages.push(update.usage);
      else if (update.type === "compaction.finished") {
        finished.push(id);
        changed();
      } else if (update.type !== "metadata.changed") {
        events.push(update);
      }
    });
    const compact = (id: string) =>
      driver.compact({ handle: { providerSessionId: id, cwd: process.cwd() } });
    try {
      await driver.start();
      await compact("normal");
      assert.equal(
        events.length,
        0,
        "returns on acknowledgement, not operation completion",
      );
      assert.deepEqual([...finished], []);
      await assert.rejects(compact("normal"), /busy/);
      await nextUpdate;
      assert.deepEqual([...finished], ["normal"]);
      assert.deepEqual(usages, [{ usedTokens: 12000, maxTokens: 272000 }]);
      assert(
        events.some(
          (event) =>
            event.type === "system.notice" && event.text === "上下文已压缩",
        ),
      );
      await assert.rejects(compact("rpc-failure"), /cannot compact/);
      nextUpdate = new Promise<void>((resolve) => {
        changed = resolve;
      });
      await compact("async-failure");
      await nextUpdate;
      assert(
        events.some(
          (event) =>
            event.type === "system.notice" &&
            event.text === "compaction failed",
        ),
      );
      await compact("early");
      assert(finished.includes("early"));
      nextUpdate = new Promise<void>((resolve) => {
        changed = resolve;
      });
      await compact("disconnect");
      await nextUpdate;
      assert.deepEqual(
        [...finished],
        ["normal", "rpc-failure", "async-failure", "early", "disconnect"],
      );
      const requests = (await readFile(transcript, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(
        requests.filter((request) => request.method === "turn/start").length,
        0,
      );
      assert.equal(
        requests.filter((request) => request.method === "thread/compact/start")
          .length,
        5,
      );
    } finally {
      await driver.close();
    }
  },
);

test(
  "Codex deleteSession validates thread cwd before issuing thread/delete",
  { timeout: 10_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "racco-delete-wire-"));
    const transcript = join(directory, "requests.jsonl");
    const previousPath = process.env.PATH;
    process.env.PATH = `${directory}:${previousPath}`;
    t.after(async () => {
      process.env.PATH = previousPath;
      await rm(directory, { recursive: true, force: true });
    });
    await writeFile(
      join(directory, "codex"),
      `#!/usr/bin/env node
const fs = require('node:fs');
const lines = require('node:readline').createInterface({ input: process.stdin });
const send = message => process.stdout.write(JSON.stringify(message) + '\\n');
lines.on('line', line => {
  const message = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(transcript)}, line + '\\n');
  if (message.id === undefined) return;
  let result = {};
  if (message.method === 'thread/read') {
    const cwd = message.params.threadId === 'thread-foreign' ? process.env.HOME : process.env.RACCO_TEST_THREAD_CWD;
    result = { thread: { id: message.params.threadId, cwd, source: null, parentThreadId: null, agentNickname: null, agentRole: null, createdAt: 0, updatedAt: 0, preview: '', name: null, status: { type: 'notLoaded' }, turns: [] } };
  }
  if (message.method === 'thread/delete') result = { deleted: true };
  send({ id: message.id, result });
});
`,
      { mode: 0o700 },
    );
    const log = { info() {}, warn() {} };
    const driver = new CodexDriver(log);
    try {
      const cwd = process.cwd();
      process.env.RACCO_TEST_THREAD_CWD = cwd;
      await driver.start();
      await driver.deleteSession({
        providerSessionId: "thread-to-delete",
        cwd,
      });
      const requests = (await readFile(transcript, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter(
          (request) =>
            request.method === "thread/read" ||
            request.method === "thread/delete",
        );
      assert.deepEqual(requests, [
        {
          id: 2,
          method: "thread/read",
          params: { threadId: "thread-to-delete" },
        },
        {
          id: 3,
          method: "thread/delete",
          params: { threadId: "thread-to-delete" },
        },
      ]);

      // A thread owned by another directory must not reach thread/delete.
      await writeFile(transcript, "");
      await assert.rejects(
        driver.deleteSession({ providerSessionId: "thread-foreign", cwd }),
        /does not match/,
      );
      const after = (await readFile(transcript, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((request) => request.method === "thread/delete");
      assert.deepEqual(after, []);
    } finally {
      await driver.close();
      delete process.env.RACCO_TEST_THREAD_CWD;
    }
  },
);

test(
  "Codex relays user answers and rejects tool approval requests without a UI interaction",
  { timeout: 10_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "racco-question-wire-"));
    const transcript = join(directory, "responses.jsonl");
    const previousPath = process.env.PATH;
    process.env.PATH = `${directory}:${previousPath}`;
    t.after(async () => {
      process.env.PATH = previousPath;
      await rm(directory, { recursive: true, force: true });
    });
    await writeFile(
      join(directory, "codex"),
      `#!/usr/bin/env node
const fs = require('node:fs');
const lines = require('node:readline').createInterface({ input: process.stdin });
const send = message => process.stdout.write(JSON.stringify(message) + '\\n');
const turn = { id: 'turn', status: 'completed', items: [], error: null };
let remaining = 3;
lines.on('line', line => {
  const message = JSON.parse(line);
  if (message.method === undefined) {
    fs.appendFileSync(${JSON.stringify(transcript)}, line + '\\n');
    if (--remaining === 0) send({ method: 'turn/completed', params: { threadId: 'thread', turn } });
    return;
  }
  if (message.id === undefined) return;
  if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn } });
    for (const [id, method] of [['command', 'item/commandExecution/requestApproval'], ['file', 'item/fileChange/requestApproval']]) {
      send({ id, method, params: { threadId: 'thread', turnId: 'turn', itemId: id } });
    }
    send({ id: 'question', method: 'item/tool/requestUserInput', params: { threadId: 'thread', turnId: 'turn', itemId: 'question', questions: [{ id: 'target', header: 'Target', question: 'Which target?', isOther: true, isSecret: false, options: null }] } });
  } else send({ id: message.id, result: {} });
});
`,
      { mode: 0o700 },
    );
    const driver = new CodexDriver({ info() {}, warn() {} });
    let questions = 0;
    try {
      await driver.start();
      await driver.runTurn({
        handle: { providerSessionId: "thread", cwd: process.cwd() },
        mode: "resume",
        prompt: "Choose the target",
        modelSettings: { modelId: "model", reasoningEffort: "high" },
        signal: new AbortController().signal,
        context: {
          emit() {},
          setState() {},
          markProviderMaterialized() {},
          async requestInteraction(request) {
            questions++;
            assert.equal(request.questions[0]?.text, "Which target?");
            return { decision: "answer", answers: { target: ["test"] } };
          },
        },
      });
      assert.equal(questions, 1);
      const responses = (await readFile(transcript, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      for (const id of ["command", "file"]) {
        assert.match(
          responses.find((response) => response.id === id).error.message,
          /Unsupported Codex server request/,
        );
      }
      assert.deepEqual(
        responses.find((response) => response.id === "question").result,
        { answers: { target: { answers: ["test"] } } },
      );
    } finally {
      await driver.close();
    }
  },
);
