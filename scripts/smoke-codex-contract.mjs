// No model calls: a fresh CODEX_HOME, one fixed printf command, then real history.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  validateCodexHandshake,
  CODEX_HISTORY_MODE,
} from "../src/server/drivers/codex/contract.ts";
const directory = await mkdtemp(join(tmpdir(), "racco-contract-"));
const home = join(directory, "home");
await mkdir(home);
const child = spawn(
  process.env.RACCO_CODEX_BIN ?? "codex",
  ["app-server", "--listen", "stdio://"],
  {
    cwd: directory,
    env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
  },
);
const closed = new Promise((resolve) => child.once("close", resolve));
const pending = new Map();
let nextId = 0;
let complete;
let completedCommand;
const terminal = new Promise((resolve) => {
  complete = resolve;
});
const lines = createInterface({ input: child.stdout });
let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});
child.on("error", (error) => {
  for (const request of pending.values()) request.reject(error);
});
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (
    message.method === "item/completed" &&
    message.params.item.type === "commandExecution"
  )
    completedCommand = message.params.item;
  if (message.method === "turn/completed") complete();
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  if (message.error) request.reject(new Error(JSON.stringify(message.error)));
  else request.resolve(message.result);
});
function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}
function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });
}
const deadline = setTimeout(() => {
  child.kill("SIGKILL");
  for (const request of pending.values())
    request.reject(new Error(`Contract smoke timed out: ${stderr}`));
  complete();
}, 15_000);
try {
  validateCodexHandshake(
    await request("initialize", {
      clientInfo: { name: "racco", title: "Racco", version: "0.0.1" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    }),
  );
  send({ method: "initialized" });
  const { thread } = await request("thread/start", {
    cwd: directory,
    historyMode: CODEX_HISTORY_MODE,
    approvalPolicy: "never",
    sandbox: "read-only",
    persistExtendedHistory: true,
    experimentalRawEvents: false,
  });
  assert.equal(thread.historyMode, CODEX_HISTORY_MODE);
  await request("thread/shellCommand", {
    threadId: thread.id,
    command: "printf racco-contract-smoke",
    timeoutMs: 1000,
  });
  await terminal;
  const snapshot = await request("thread/read", {
    threadId: thread.id,
    includeTurns: true,
  });
  assert.equal(snapshot.thread.turns.at(-1).status, "completed");
  assert.equal(completedCommand.aggregatedOutput, "racco-contract-smoke");
  assert.equal(completedCommand.exitCode, 0);
  console.log(
    "Codex contract: handshake, real command events and full-history read passed (no model call)",
  );
} finally {
  clearTimeout(deadline);
  child.kill("SIGTERM");
  const force = setTimeout(() => child.kill("SIGKILL"), 3000);
  await closed;
  clearTimeout(force);
  lines.close();
  await rm(directory, { recursive: true, force: true });
}
