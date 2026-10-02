import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { installFakeCodex } from "../fixtures/codex-peer.ts";
import { isolatedServer } from "../../scripts/lib/isolated-server.mjs";
import { runResumeSmoke } from "../../scripts/lib/resume-smoke.mjs";
import { cleanupSmokeSessions } from "../../scripts/lib/smoke-target.mjs";
import { assertSmokeHistory } from "../../scripts/lib/smoke-history.mjs";

test(
  "compiled daemon cold resume preserves native identity and recalls an un-repeated memory value",
  { timeout: 60000 },
  async (t) => {
    const peer = await installFakeCodex(t, {
      script: `
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
const file = join(process.env.HOME, 'native-memory.json');
const read = () => existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
const save = thread => writeFileSync(file, JSON.stringify(thread));
export const handlers = {
  initialize: () => ({ userAgent: 'racco/0.160.0 test', codexHome: process.env.HOME, platformFamily: 'unix', platformOs: 'linux' }),
  'model/list': () => ({data:[{model:'test-model',displayName:'Test',description:'',hidden:false,inputModalities:['text'],isDefault:true,supportedReasoningEfforts:[{reasoningEffort:'low',description:''}],defaultReasoningEffort:'low'}],nextCursor:null}),
  'thread/start': params => {
    if (read()) throw new Error('Unexpected replacement thread');
    const thread = {id:'native-memory',cwd:params.cwd,preview:'Memory',name:null,createdAt:1700000000,updatedAt:1700000000,status:{type:'idle'},parentThreadId:null,agentNickname:null,agentRole:null,source:'appServer',turns:[]}; save(thread); return {thread};
  },
  'thread/list': params => ({data: params.ancestorThreadId ? [] : [read()].filter(Boolean),nextCursor:null}),
  'thread/read': params => {const thread=read(); if(!thread || params.threadId!==thread.id) throw new Error('thread not found'); return {thread};},
  'thread/resume': params => {const thread=read(); if(!thread || params.threadId!==thread.id) throw new Error('wrong native resume id'); return {thread};},
  'thread/delete': () => {unlinkSync(file); return {};},
  'turn/start': (params, {notify,afterReply}) => {
    const thread=read(); if(params.threadId!==thread.id) throw new Error('wrong native turn id');
    const prompt=params.input[0].text;
    if (!thread.turns.length) thread.memory=prompt.match(/MEMORY_[a-f0-9]+/)[0];
    else if(prompt.includes(thread.memory)) throw new Error('Resume prompt repeated the answer');
    const index=thread.turns.length+1;
    const user={type:'userMessage',id:'user-'+index,content:[{type:'text',text:prompt,text_elements:[]}]};
    const assistant={type:'agentMessage',id:'assistant-'+index,text:thread.memory,phase:'final_answer'};
    const turn={id:'turn-'+index,status:'completed',items:[user,assistant],error:null};
    thread.turns.push(turn);save(thread);
    afterReply(()=>{notify('item/completed',{threadId:thread.id,turnId:turn.id,item:assistant});notify('turn/completed',{threadId:thread.id,turn});});
    return {turn:{...turn,status:'inProgress',items:[]}};
  },
};`,
    });
    const nativeHome = join(peer.directory, "home");
    await mkdir(nativeHome);
    const server = await isolatedServer({
      environment: {
        HOME: nativeHome,
        CLAUDE_CONFIG_DIR: join(nativeHome, "claude"),
      },
    });
    try {
      assert.equal(
        (await runResumeSmoke(server, "codex")).nativeId,
        "native-memory",
      );
      const requests = await peer.requests();
      const turns = requests.filter(
        (request) => request.method === "turn/start",
      );
      assert.equal(turns.length, 2);
      assert.equal(
        requests.filter((request) => request.method === "initialize").length,
        2,
      );
      assert.equal(
        requests.filter((request) => request.method === "thread/start").length,
        1,
      );
      assert.equal(
        requests.filter((request) => request.method === "thread/resume").length,
        1,
      );
      assert.match(turns[0].params.input[0].text, /MEMORY_/);
      assert.doesNotMatch(turns[1].params.input[0].text, /MEMORY_/);
      await cleanupSmokeSessions(server.baseUrl, {
        provider: "codex",
        cwd: server.cwd,
      });
    } finally {
      await server.close();
    }
  },
);

test("history validation rejects unrelated event counts and reordered messages", () => {
  const events = [
    { type: "user.message", id: "u1", text: "first" },
    { type: "assistant.message", id: "a1", text: "one" },
    { type: "user.message", id: "u2", text: "second" },
    { type: "assistant.message", id: "a2", text: "two" },
  ];
  assertSmokeHistory({ events }, ["first", "second"], ["one", "two"]);
  assert.throws(() =>
    assertSmokeHistory(
      { events: events.map((event) => ({ ...event, text: "unrelated" })) },
      ["first", "second"],
      ["one", "two"],
    ),
  );
  assert.throws(() =>
    assertSmokeHistory(
      { events: [...events].reverse() },
      ["first", "second"],
      ["one", "two"],
    ),
  );
});
