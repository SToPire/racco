import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { installFakeCodex } from "../../../../test/fixtures/codex-peer.js";
import { temporaryImages } from "../../../../test/images.js";
import { CodexDriver } from "./codex-driver.js";

test(
  "manual recovery waits for native exit, preserves updates and refuses active descendants",
  { timeout: 10000 },
  async (t) => {
    const peer = await installFakeCodex(t, {
      script: `
import {appendFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
const root={id:'root',cwd:process.cwd(),preview:'Test',name:null,createdAt:1,updatedAt:1,status:{type:'idle'},parentThreadId:null,agentNickname:null,agentRole:null,source:'appServer',turns:[]};
export const handlers={
 initialize:()=>{appendFileSync(join(import.meta.dirname,'pids'),process.pid+'\\n');return {userAgent:'racco/0.160.0 test',codexHome:'/tmp/test',platformFamily:'unix',platformOs:'linux'};},
 'thread/start':()=>({thread:root}),
 'thread/read':()=>({thread:root}),
 'thread/compact/start':(_params,peer)=>{peer.afterReply(()=>peer.notify('turn/completed',{threadId:'root',turn:{id:'compact',status:'completed',items:[],error:null}}));return {};},
 'turn/start':(_params,peer)=>{
   const turn={id:'main-turn',status:'completed',items:[],error:null};
   peer.afterReply(()=>{
     peer.notify('thread/started',{thread:{...root,id:'child',parentThreadId:'root',status:{type:'active',activeFlags:[]},turns:[{id:'child-turn',status:'inProgress',items:[],error:null}]}});
     peer.notify('turn/completed',{threadId:'root',turn});
   });return {turn};
 },
 'model/list':(_params,peer)=>{
   if(existsSync(join(import.meta.dirname,'crash'))){process.exit(2);}
   peer.notify('turn/completed',{threadId:'child',turn:{id:'child-turn',status:'completed',items:[],error:null}});
   return {data:[],nextCursor:null};
 }
};
`,
    });
    const driver = new CodexDriver(
      { info() {}, warn() {} },
      await temporaryImages(),
    );
    t.after(() => driver.close());
    let updates = 0;
    driver.onSessionUpdate(() => updates++);
    await driver.start();
    const modelSettings = { modelId: "test", reasoningEffort: null };
    const creating = driver.createSession({
      raccoSessionId: "test",
      cwd: process.cwd(),
      modelSettings,
    });
    await assert.rejects(driver.restart(), /进行中/);
    const handle = await creating;
    const compacting = driver.compact({ handle });
    await assert.rejects(driver.restart(), /进行中/);
    await compacting;
    assert.equal(
      (await peer.requests()).filter((x) => x.method === "thread/compact/start")
        .length,
      1,
    );
    await driver.runTurn({
      handle,
      mode: "first",
      content: [{ type: "text", text: "test" }],
      modelSettings,
      signal: new AbortController().signal,
      context: {
        emit() {},
        setState() {},
        markProviderMaterialized() {},
        async requestInteraction() {
          throw new Error("unexpected");
        },
      },
    });
    assert.equal(driver.hasActiveDescendants(handle), true);
    await assert.rejects(driver.restart(), /子 Agent/);
    assert.equal(driver.ready, true);
    await driver.listModels({
      cwd: process.cwd(),
      signal: new AbortController().signal,
    });
    assert.equal(driver.hasActiveDescendants(handle), false);
    const priorUpdates = updates;
    await driver.restart();
    const pids = (await readFile(join(peer.directory, "pids"), "utf8"))
      .trim()
      .split("\n")
      .map(Number);
    assert.equal(pids.length, 2);
    assert.throws(() => process.kill(pids[0], 0), { code: "ESRCH" });
    assert.equal(driver.ready, true);
    const requests = await peer.requests();
    assert.equal(requests.filter((x) => x.method === "turn/start").length, 1);
    // Reconnected drivers retain the hub listener and start from an unloaded native session.
    await driver.createSession({
      raccoSessionId: "next",
      cwd: process.cwd(),
      modelSettings,
    });
    await driver.runTurn({
      handle,
      mode: "first",
      content: [{ type: "text", text: "next" }],
      modelSettings,
      signal: new AbortController().signal,
      context: {
        emit() {},
        setState() {},
        markProviderMaterialized() {},
        async requestInteraction() {
          throw new Error("unexpected");
        },
      },
    });
    await driver.listModels({
      cwd: process.cwd(),
      signal: new AbortController().signal,
    });
    assert(updates > priorUpdates);
    await writeFile(join(peer.directory, "crash"), "");
    await assert.rejects(
      driver.listModels({
        cwd: process.cwd(),
        signal: new AbortController().signal,
      }),
      /exited/,
    );
    assert.equal(driver.ready, false);
    await driver.restart();
    assert.equal(driver.ready, true);
    assert.equal(
      (await peer.requests()).filter((x) => x.method === "turn/start").length,
      2,
    );
    const recovering = driver.restart();
    const closing = driver.close();
    await assert.rejects(recovering, /closed during recovery/);
    await closing;
    assert.equal(driver.ready, false);
    assert.equal(
      (await readFile(join(peer.directory, "pids"), "utf8")).trim().split("\n")
        .length,
      3,
    );
  },
);
