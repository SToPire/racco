import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexDriver } from "./codex-driver.js";

test("Codex pages the exact project without reading/resuming candidates and leaves writer conflicts to the provider", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "racco-discovery-wire-"));
  const cwd = join(directory, "project");
  await mkdir(cwd);
  const transcript = join(directory, "requests.jsonl");
  const previousPath = process.env.PATH;
  process.env.PATH = `${directory}:${previousPath}`;
  const driver = new CodexDriver({ info() {}, warn() {} });
  t.after(async () => {
    await driver.close();
    process.env.PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(
    join(directory, "codex"),
    `#!/usr/bin/env node
const fs = require('node:fs');
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  fs.appendFileSync(${JSON.stringify(transcript)}, line + '\\n');
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
  if (message.method === 'thread/resume') return send({id:message.id,error:{code:-32600,message:'thread example already has an active writer'}});
  let result = {};
  if (message.method === 'thread/list') {
    const base = {id:'root',cwd:${JSON.stringify(cwd)},name:'Native title',preview:'Preview',updatedAt:1700000000,parentThreadId:null,source:'cli'};
    result = {data:message.params.cursor ? [] : [base,{...base,id:'outside',cwd:${JSON.stringify(directory)}},{...base,id:'child',parentThreadId:'root'},{...base,id:'sidechain',source:{subAgent:'review'}}], nextCursor:message.params.cursor === 'next' ? null : 'next'};
  }
  send({id:message.id,result});
});
`,
    { mode: 0o700 },
  );
  await driver.start();
  const signal = new AbortController().signal;
  const first = await driver.listSessions({ cwd, signal });
  assert.deepEqual(
    first.sessions.map((session) => session.providerSessionId),
    ["root"],
  );
  assert.equal(first.sessions[0].title, "Native title");
  assert.equal(first.nextCursor, "next");
  assert.equal(
    (await driver.listSessions({ cwd, signal, cursor: "next" })).nextCursor,
    null,
  );
  const calls = (await readFile(transcript, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(
    !calls.some((call) =>
      ["thread/read", "thread/resume", "turn/start"].includes(call.method),
    ),
  );
  const params = calls.find((call) => call.method === "thread/list").params;
  assert.equal(params.cwd, cwd);
  assert.equal(params.useStateDbOnly, true);
  assert.equal(params.archived, false);
  assert.equal(params.sortKey, "updated_at");
  assert.deepEqual(params.sourceKinds, [
    "cli",
    "vscode",
    "exec",
    "appServer",
    "unknown",
  ]);
  await assert.rejects(
    driver.compact({ handle: { providerSessionId: "root", cwd } }),
    /其他 Codex 窗口/,
  );
});
