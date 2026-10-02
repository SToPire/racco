import assert from "node:assert/strict";
import test from "node:test";
import { installFakeCodex } from "../../../../test/fixtures/codex-peer.js";
import { temporaryImages } from "../../../../test/images.js";
import type { TimelineEvent } from "../../../shared/protocol.js";
import { buildTimeline } from "../../../web/store.js";
import { CodexDriver } from "./codex-driver.js";

for (const terminal of ["turn/completed", "error"] as const) {
  test(`late child ${terminal} closes only the old turn while the new stream continues`, async (t) => {
    const peer = await installFakeCodex(t, {
      script: `
const root={id:'root',cwd:process.cwd(),preview:'Test',name:null,createdAt:1,updatedAt:1,status:{type:'idle'},parentThreadId:null,agentNickname:null,agentRole:null,source:'appServer',turns:[]};
const command=(id,output)=>({type:'commandExecution',id,command:id,cwd:process.cwd(),status:'inProgress',commandActions:[],aggregatedOutput:output,exitCode:null,durationMs:null,processId:null,source:'agent',pluginId:null,scriptPath:null});
const child={...root,id:'child',parentThreadId:'root',agentNickname:'Worker',status:{type:'active',activeFlags:[]},turns:[{id:'old',status:'inProgress',error:null,items:[command('old-command','old')]}]};
let phase=0;
export const handlers={
 initialize:()=>({userAgent:'racco/0.160.0 test',codexHome:'/tmp/test',platformFamily:'unix',platformOs:'linux'}),
 'thread/read':({threadId})=>({thread:threadId==='root'?root:child}),
 'thread/list':()=>({data:[child],nextCursor:null}),
 'model/list':(_params,peer)=>{
   const notify=(method,params)=>peer.notify(method,{threadId:'child',turnId:'new',...params});
   if(phase++===0){
     notify('turn/started',{turn:{id:'new',status:'inProgress',error:null,items:[]}});
     notify('item/started',{item:command('new-command','new')});
     notify('item/started',{item:{type:'agentMessage',id:'new-message',text:'prefix',phase:'commentary'}});
     if(${JSON.stringify(terminal)}==='turn/completed') notify('turn/completed',{turn:{id:'old',status:'completed',error:null,items:[]}});
     else notify('error',{turnId:'old',willRetry:false,error:{message:'old turn failed'}});
     notify('item/commandExecution/outputDelta',{itemId:'new-command',delta:' tail'});
     notify('item/agentMessage/delta',{itemId:'new-message',delta:' tail'});
   } else notify('turn/completed',{turn:{id:'new',status:'completed',error:null,items:[]}});
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
    const events: TimelineEvent[] = [];
    driver.onSessionUpdate((_id, event) => {
      if (
        event.type === "subagent.started" ||
        event.type === "subagent.state" ||
        event.type === "subagent.event"
      )
        events.push(event);
    });
    await driver.start();
    const snapshot = await driver.readSession({
      providerSessionId: "root",
      cwd: process.cwd(),
    });
    const advance = () =>
      driver.listModels({
        cwd: process.cwd(),
        signal: new AbortController().signal,
      });
    await advance(); // The RPC response follows the interleaved notifications on real stdio.
    const childRow = () => {
      const row = buildTimeline([...snapshot.events, ...events]).find(
        (row) => row.type === "subagent",
      );
      assert(row?.type === "subagent");
      return row;
    };
    const running = childRow();
    assert.equal(running.state, "running");
    const old = running.timeline.find((row) => row.id.endsWith(":old-command"));
    assert(old?.type === "tool");
    assert.equal(old.status, terminal === "error" ? "failed" : "incomplete");
    const current = running.timeline.find((row) =>
      row.id.endsWith(":new-command"),
    );
    assert(current?.type === "tool");
    assert.equal(current.status, "running");
    assert.equal(current.output, "new tail");
    const text = running.timeline.find((row) =>
      row.id.endsWith(":new-message"),
    );
    assert(text?.type === "assistant.message");
    assert.equal(text.text, "prefix tail");
    assert.equal(text.partial, true);
    await advance();
    assert.equal(childRow().state, "completed");
    assert.equal(
      (await peer.requests()).filter(
        (request) => request.method === "model/list",
      ).length,
      2,
    );
  });
}
