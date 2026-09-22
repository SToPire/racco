import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TimelineEvent, SessionState } from "../../../shared/protocol.js";
import { buildTimeline } from "../../../web/store.js";
import { CodexDriver } from "./codex-driver.js";

for (const exitMode of ["exit", "close"]) {
  test(
    `Codex child streams survive parent completion, snapshot and the next turn, then settle on ${exitMode}`,
    { timeout: 10000 },
    async (t) => {
      const directory = await mkdtemp(join(tmpdir(), "racco-background-"));
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
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const root = { id: 'root', cwd: ${JSON.stringify(process.cwd())}, preview: 'Background work', name: null, createdAt: 1700000000, updatedAt: 1700000010, status: { type: 'idle' }, parentThreadId: null, agentNickname: null, agentRole: null, source: 'appServer', turns: [] };
const children = new Map();
let turns = 0, probes = 0;
const emit = (threadId, method, values) => send({ method, params: { threadId, ...values } });
function spawn(id, parent = 'root') {
  const command = { type: 'commandExecution', id: id + '-command', command: 'work', cwd: root.cwd, status: 'inProgress', commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null, processId: null, source: 'agent', pluginId: null, scriptPath: null };
  const turn = { id: id + '-turn', items: [command], status: 'inProgress', error: null };
  const child = { ...root, id, parentThreadId: parent, agentNickname: id, status: { type: 'active', activeFlags: [] }, turns: [turn] };
  children.set(id, child);
  send({ method: 'thread/started', params: { thread: { ...child, turns: [] } } });
  emit(id, 'turn/started', { turn });
  emit(id, 'item/started', { turnId: turn.id, item: command });
}
function output(id, text) {
  const child = children.get(id), turn = child.turns[0], command = turn.items[0];
  command.aggregatedOutput = (command.aggregatedOutput || '') + text;
  emit(id, 'item/commandExecution/outputDelta', { turnId: turn.id, itemId: command.id, delta: text });
}
function finish(id, status) {
  const child = children.get(id), turn = child.turns[0], command = turn.items[0];
  if (status === 'completed') {
    command.status = 'completed'; command.exitCode = 0;
    emit(id, 'item/completed', { turnId: turn.id, item: command });
  }
  turn.status = status; child.status = { type: 'idle' };
  emit(id, 'turn/completed', { turn });
}
lines.on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === 'thread/start') return send({ id: message.id, result: { thread: root } });
  if (message.method === 'thread/read') return send({ id: message.id, result: { thread: message.params.threadId === 'root' ? root : children.get(message.params.threadId) } });
  if (message.method === 'thread/list') return send({ id: message.id, result: { data: [...children.values()], nextCursor: null } });
  if (message.method === 'model/list') {
    if (++probes === 1) { output('child', 'idle output\\n'); spawn('nested', 'child'); spawn('state-only'); }
    else spawn('pending-at-exit');
    send({ id: message.id, result: { data: [], nextCursor: null } });
    if (probes === 2 && ${JSON.stringify(exitMode)} === 'exit') setTimeout(() => process.exit(2), 5);
    return;
  }
  if (message.method !== 'turn/start') return send({ id: message.id, result: {} });
  const turn = { id: 'main-' + (++turns), items: [], status: 'inProgress', error: null };
  send({ id: message.id, result: { turn } });
  setTimeout(() => {
    emit('root', 'turn/started', { turn });
    if (turns === 1) spawn('child');
    else { output('child', 'next-turn output'); finish('child', 'completed'); output('nested', 'before interruption'); finish('nested', 'interrupted'); emit('state-only', 'thread/status/changed', { status: { type: 'idle' } }); }
    turn.status = 'completed'; root.turns.push(turn);
    emit('root', 'turn/completed', { turn });
  }, 5);
});
`,
        { mode: 0o700 },
      );
      const driver = new CodexDriver({ info() {}, warn() {} });
      let displayed: TimelineEvent[] = [];
      const updates: TimelineEvent[] = [];
      const mainStates: SessionState[] = [];
      let didExit!: () => void;
      const exited = new Promise<void>((resolve) => {
        didExit = resolve;
      });
      driver.onSessionUpdate((rootId, update) => {
        assert.equal(rootId, "root");
        if (
          update.type === "subagent.started" ||
          update.type === "subagent.state" ||
          update.type === "subagent.event"
        ) {
          updates.push(update);
          displayed.push(update);
          if (update.type === "subagent.state" && update.state === "error")
            didExit();
        }
      });
      const context = {
        emit: (event: TimelineEvent) => displayed.push(event),
        setState: (state: SessionState) => mainStates.push(state),
        markProviderMaterialized() {},
        async requestInteraction() {
          throw new Error("Unexpected interaction");
        },
      };
      const children = () =>
        buildTimeline(displayed).filter((row) => row.type === "subagent");
      try {
        await driver.start();
        const modelSettings = { modelId: "model", reasoningEffort: null };
        const handle = await driver.createSession({
          raccoSessionId: "session",
          cwd: process.cwd(),
          modelSettings,
        });
        const run = () =>
          driver.runTurn({
            handle,
            mode: "resume",
            prompt: "work",
            modelSettings,
            context,
            signal: new AbortController().signal,
          });
        await run();
        const childId = children()[0].agentId;
        assert.equal(children()[0].state, "running");
        assert.deepEqual(mainStates, ["running", "idle"]);
        await driver.listModels({
          cwd: process.cwd(),
          signal: new AbortController().signal,
        });
        assert(
          updates.some(
            (event) =>
              event.type === "subagent.event" &&
              event.event.type === "tool.output" &&
              event.event.output === "idle output\n",
          ),
        );
        assert.equal(
          children().find((row) => row.name === "nested")?.parentAgentId,
          childId,
        );
        const snapshot = await driver.readSession(handle);
        displayed = snapshot.events;
        assert.equal(
          children().find((row) => row.name === "child")?.agentId,
          childId,
        );
        await run();
        assert.deepEqual(mainStates, ["running", "idle", "running", "idle"]);
        const child = children().find((row) => row.name === "child")!;
        assert.equal(child.state, "completed");
        assert(child.timeline[0].type === "tool");
        assert.equal(child.timeline[0].output, "idle output\nnext-turn output");
        assert.equal(child.timeline[0].status, "completed");
        const nested = children().find((row) => row.name === "nested")!;
        assert.equal(nested.state, "interrupted");
        assert(nested.timeline[0].type === "tool");
        assert.equal(nested.timeline[0].status, "interrupted");
        const stateOnly = children().find((row) => row.name === "state-only")!;
        assert.equal(stateOnly.state, "completed");
        assert(stateOnly.timeline[0].type === "tool");
        assert.equal(stateOnly.timeline[0].status, "incomplete");
        await driver.listModels({
          cwd: process.cwd(),
          signal: new AbortController().signal,
        });
        if (exitMode === "close") await driver.close();
        await exited;
        const pending = children().find(
          (row) => row.name === "pending-at-exit",
        )!;
        assert.equal(pending.state, "error");
        assert(pending.timeline[0].type === "tool");
        assert.equal(pending.timeline[0].status, "failed");
        assert.equal(
          children().find((row) => row.name === "child")?.state,
          "completed",
        );
        assert.equal(
          children().find((row) => row.name === "nested")?.state,
          "interrupted",
        );
        assert.equal(
          children().find((row) => row.name === "state-only")?.state,
          "completed",
        );
        assert.deepEqual(mainStates, ["running", "idle", "running", "idle"]);
        const terminalUpdates = updates.filter(
          (event) => event.type === "subagent.state" && event.state === "error",
        ).length;
        await driver.close();
        assert.equal(
          updates.filter(
            (event) =>
              event.type === "subagent.state" && event.state === "error",
          ).length,
          terminalUpdates,
        );
      } finally {
        await driver.close();
      }
    },
  );
}
