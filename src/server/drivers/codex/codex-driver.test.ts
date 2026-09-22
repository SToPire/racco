import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexDriver } from "./codex-driver.js";
import type { ContextUsage, TimelineEvent } from "../../../shared/protocol.js";
import type { DriverContext } from "../driver.js";
import { buildTimeline } from "../../../web/store.js";

test(
  "Codex settles unfinished tool calls on native interruption, failure, missing results and provider exit",
  { timeout: 10000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "racco-tool-lifecycle-"));
    const previousPath = process.env.PATH;
    process.env.PATH = `${directory}:${previousPath}`;
    t.after(async () => {
      process.env.PATH = previousPath;
      await rm(directory, { recursive: true, force: true });
    });
    await writeFile(
      join(directory, "codex"),
      `#!/usr/bin/env node
const lines = require('node:readline').createInterface({ input: process.stdin });
const send = message => process.stdout.write(JSON.stringify(message) + '\\n');
lines.on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === 'thread/start') return send({ id: message.id, result: { thread: { id: 'root', cwd: message.params.cwd } } });
  if (message.method !== 'turn/start') return send({ id: message.id, result: {} });
  const scenario = message.params.input[0].text;
  const turn = { id: 'turn', status: 'inProgress', items: [], error: null };
  send({ id: message.id, result: { turn } });
  const emit = (method, values) => send({ method, params: { threadId: 'root', turnId: 'turn', ...values } });
  setTimeout(() => {
    const command = { type: 'commandExecution', id: 'launcher', command: 'launch process', cwd: '/tmp', status: 'completed', commandActions: [], aggregatedOutput: 'Background process launched', exitCode: 0, durationMs: null, processId: 'background', source: 'agent', pluginId: null, scriptPath: null };
    emit('item/completed', { item: command });
    emit('item/completed', { item: { ...command, id: 'failed-before-stop', status: 'failed', exitCode: 7 } });
    emit('item/started', { item: { ...command, id: 'pending', status: 'inProgress', aggregatedOutput: null, exitCode: null, processId: null } });
    emit('item/commandExecution/outputDelta', { itemId: 'pending', delta: 'Last received output' });
    if (scenario === 'close') return;
    if (scenario === 'exit') return setTimeout(() => process.exit(2), 5);
    if (scenario === 'error') return emit('error', { error: { message: 'Native tool error' }, willRetry: false });
    emit('turn/completed', { turn: { ...turn, status: scenario, error: scenario === 'failed' ? { message: 'Native turn failed' } : null } });
  }, 5);
});
`,
      { mode: 0o700 },
    );
    for (const [scenario, expected] of [
      ["completed", "incomplete"],
      ["interrupted", "interrupted"],
      ["failed", "failed"],
      ["error", "failed"],
      ["exit", "failed"],
      ["close", "failed"],
    ] as const) {
      const driver = new CodexDriver({ info() {}, warn() {} });
      const events: TimelineEvent[] = [];
      let sawOutput!: () => void;
      const started = new Promise<void>((resolve) => {
        sawOutput = resolve;
      });
      const context: DriverContext = {
        emit(event) {
          events.push(event);
          if (event.type === "tool.output" && event.id === "pending")
            sawOutput();
        },
        setState() {},
        markProviderMaterialized() {},
        async requestInteraction() {
          throw new Error("Unexpected interaction");
        },
      };
      try {
        await driver.start();
        const modelSettings = { modelId: "model", reasoningEffort: null };
        const handle = await driver.createSession({
          raccoSessionId: "session",
          cwd: process.cwd(),
          modelSettings,
        });
        const completion = driver.runTurn({
          handle,
          mode: "first",
          prompt: scenario,
          modelSettings,
          context,
          signal: new AbortController().signal,
        });
        void completion.catch(() => undefined);
        if (scenario === "close") {
          await started;
          await driver.close();
        }
        if (scenario === "completed" || scenario === "interrupted")
          await completion;
        else await assert.rejects(completion);
        const rows = buildTimeline(events);
        const pending = rows.find((row) => row.id === "pending");
        assert(pending?.type === "tool");
        assert.equal(pending.status, expected, scenario);
        assert.equal(pending.output, "Last received output");
        const launcher = rows.find((row) => row.id === "launcher");
        assert(launcher?.type === "tool");
        assert.equal(launcher.status, "completed");
        const failed = rows.find((row) => row.id === "failed-before-stop");
        assert(failed?.type === "tool");
        assert.equal(failed.status, "failed");
        assert.equal(
          events.filter(
            (event) =>
              event.type === "tool.completed" && event.id === "pending",
          ).length,
          1,
        );
      } finally {
        await driver.close();
      }
    }
  },
);

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
  "Codex forwards public activity and child ownership while native history retains semantic item kinds",
  { timeout: 10000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "racco-activity-wire-"));
    const previousPath = process.env.PATH;
    process.env.PATH = `${directory}:${previousPath}`;
    t.after(async () => {
      process.env.PATH = previousPath;
      await rm(directory, { recursive: true, force: true });
    });
    await writeFile(
      join(directory, "codex"),
      `#!/usr/bin/env node
const lines = require('node:readline').createInterface({ input: process.stdin });
const send = message => process.stdout.write(JSON.stringify(message) + '\\n');
const items = [
  { type: 'reasoning', id: 'reason', summary: ['Inspect protocol'], content: ['PRIVATE RAW CONTENT'] },
  { type: 'plan', id: 'proposal', text: 'Update the renderer' },
  { type: 'agentMessage', id: 'progress', text: 'Checking files', phase: 'commentary' },
  { type: 'agentMessage', id: 'answer', text: 'Finished', phase: 'final_answer' },
];
const thread = { id: 'root', cwd: ${JSON.stringify(process.cwd())}, preview: 'Activity', name: null, createdAt: 1700000000, updatedAt: 1700000100, status: { type: 'idle' }, parentThreadId: null, agentNickname: null, agentRole: null, source: 'appServer', turns: [] };
lines.on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === 'thread/start' || message.method === 'thread/read') return send({ id: message.id, result: { thread } });
  if (message.method === 'thread/list') return send({ id: message.id, result: { data: [], nextCursor: null } });
  if (message.method !== 'turn/start') return send({ id: message.id, result: {} });
  const turn = { id: 'turn', items, status: 'completed', error: null };
  send({ id: message.id, result: { turn: { ...turn, items: [], status: 'inProgress' } } });
  setTimeout(() => {
    const emit = (method, values) => send({ method, params: { threadId: 'root', turnId: 'turn', ...values } });
    emit('item/started', { item: { ...items[0], summary: [] } });
    emit('item/reasoning/summaryTextDelta', { itemId: 'reason', summaryIndex: 0, delta: 'Inspect protocol' });
    emit('item/reasoning/textDelta', { itemId: 'reason', delta: 'PRIVATE RAW DELTA' });
    emit('item/completed', { item: items[0] });
    emit('item/started', { item: { ...items[1], text: '' } });
    emit('item/plan/delta', { itemId: 'proposal', delta: 'Update the renderer' });
    emit('item/completed', { item: items[1] });
    emit('turn/plan/updated', { explanation: 'Checking rendering', plan: [{ step: 'Verify UI', status: 'inProgress' }] });
    emit('item/started', { item: { ...items[2], text: '' } });
    emit('item/agentMessage/delta', { itemId: 'progress', delta: 'Checking files' });
    emit('item/completed', { item: items[2] });
    emit('item/completed', { item: items[3] });
    send({ method: 'thread/started', params: { thread: { ...thread, id: 'child', parentThreadId: 'root', agentNickname: 'Reviewer' } } });
    emit('item/completed', { threadId: 'child', turnId: 'child-turn', item: { type: 'reasoning', id: 'child-reason', summary: ['Reviewing tests'], content: ['PRIVATE CHILD CONTENT'] } });
    emit('turn/plan/updated', { threadId: 'child', turnId: 'child-turn', explanation: null, plan: [{ step: 'Review', status: 'completed' }] });
    thread.turns = [turn];
    emit('turn/completed', { turn });
  }, 5);
});
`,
      { mode: 0o700 },
    );
    const driver = new CodexDriver({ info() {}, warn() {} });
    const events: TimelineEvent[] = [];
    const context: DriverContext = {
      emit: (event) => events.push(event),
      setState() {},
      markProviderMaterialized() {},
      async requestInteraction() {
        throw new Error("Unexpected interaction");
      },
    };
    try {
      await driver.start();
      const modelSettings = { modelId: "model", reasoningEffort: null };
      const handle = await driver.createSession({
        raccoSessionId: "session",
        cwd: process.cwd(),
        modelSettings,
      });
      await driver.runTurn({
        handle,
        mode: "first",
        prompt: "Inspect",
        modelSettings,
        context,
        signal: new AbortController().signal,
      });
      const snapshot = await driver.readSession(handle);
      assert.deepEqual(
        buildTimeline(
          events.filter((event) => event.type.startsWith("assistant.")),
        ),
        buildTimeline(snapshot.events),
      );
      assert.doesNotMatch(JSON.stringify(events), /PRIVATE/);
      assert(
        events.some(
          (event) =>
            event.type === "assistant.message" &&
            event.partial &&
            event.phase === "commentary",
        ),
      );
      assert(
        events.some(
          (event) => event.type === "assistant.plan" && event.partial,
        ),
      );
      assert(
        events.some(
          (event) =>
            event.type === "plan.updated" &&
            event.steps[0].status === "inProgress",
        ),
      );
      assert(
        events.some(
          (event) =>
            event.type === "subagent.event" &&
            event.event.type === "assistant.reasoning",
        ),
      );
      assert(
        events.some(
          (event) =>
            event.type === "subagent.event" &&
            event.event.type === "plan.updated",
        ),
      );
    } finally {
      await driver.close();
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
