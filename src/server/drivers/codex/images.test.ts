import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexDriver } from "./codex-driver.js";
import { TemporaryImages } from "../../images/temporary.js";
import type { DriverContext } from "../driver.js";
import { mapItemEvents } from "./event-mapper.js";
import { CodexAppServerClient } from "./app-server-client.js";

for (const outcome of [
  "completed",
  "failed",
  "interrupted",
  "error",
  "malformed",
  "rpc-rejected",
  "rpc-internal",
  "interrupt-rejected",
] as const) {
  test(
    `Codex image files survive acceptance and are cleaned safely on ${outcome}`,
    { timeout: 15000 },
    async (t) => {
      const directory = await mkdtemp(join(tmpdir(), "racco-codex-images-"));
      const originalPath = process.env.PATH;
      process.env.PATH = `${directory}:${originalPath}`;
      const marker = join(directory, "input.json");
      const script = `#!/usr/bin/env node
const fs = require('node:fs');
const lines = require('node:readline').createInterface({ input: process.stdin });
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
process.on('SIGTERM', () => setTimeout(() => process.exit(0), 150));
lines.on('line', line => {
 const m = JSON.parse(line); if(m.id === undefined) return;
 if(m.method === 'initialize') return send({id:m.id,result:{ userAgent: 'racco/0.160.0 test', codexHome: '/tmp/codex-test', platformFamily: 'unix', platformOs: 'linux' }});
 if(m.method === 'thread/start') return send({id:m.id,result:{thread:{id:'root',cwd:m.params.cwd}}});
 if(m.method === 'turn/interrupt' && ${JSON.stringify(outcome)} === 'interrupt-rejected') return send({id:m.id,error:{code:-32602,message:'interrupt rejected'}});
 if(m.method === 'turn/interrupt') return send({id:m.id,result:{}});
 if(m.method !== 'turn/start') return send({id:m.id,error:{code:-32601,message:'Undeclared fake RPC: '+m.method}});
 const turn = {id:'current',status:'inProgress',items:[],error:null};
 fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify(m.params.input));
 if(${JSON.stringify(outcome)} === 'rpc-rejected' || ${JSON.stringify(outcome)} === 'rpc-internal') return send({id:m.id,error:{code:${outcome === "rpc-rejected" ? -32600 : -32603},message:'start rejected'}});
 send({id:m.id,result:{turn}});
 send({method:'turn/started',params:{threadId:'root',turn}});
 send({method:'turn/completed',params:{threadId:'root',turn:{...turn,id:'old',status:'completed'}}});
 setTimeout(() => {
   if(${JSON.stringify(outcome)} === 'interrupt-rejected') return;
   if(${JSON.stringify(outcome)} === 'malformed') return process.stdout.write('invalid-json\\n');
   if(${JSON.stringify(outcome)} === 'error') return send({method:'error',params:{threadId:'root',turnId:'current',error:{message:'turn outcome uncertain'},willRetry:false}});
   send({method:'turn/completed',params:{threadId:'root',turn:{...turn,status:${JSON.stringify(outcome)},error:${outcome === "failed" ? "{message:'failed'}" : "null"}}}});
 }, 50);
});
`;
      await writeFile(join(directory, "codex"), script, { mode: 0o700 });
      await mkdir(join(directory, "state"));
      const images = await TemporaryImages.open(
        join(directory, "state"),
        { warn() {} },
        directory,
      );
      const driver = new CodexDriver({ info() {}, warn() {} }, images);
      t.after(async () => {
        process.env.PATH = originalPath;
        await driver.close();
        await images.close();
        await rm(directory, { recursive: true, force: true });
      });
      let started!: () => void;
      const running = new Promise<void>((resolve) => {
        started = resolve;
      });
      const context: DriverContext = {
        emit() {},
        setState(state) {
          if (state === "running") started();
        },
        markProviderMaterialized() {},
        async requestInteraction() {
          throw new Error("unexpected");
        },
      };
      await driver.start();
      const settings = { modelId: "test", reasoningEffort: null };
      const handle = await driver.createSession({
        raccoSessionId: "test",
        cwd: directory,
        modelSettings: settings,
      });
      const controller = new AbortController();
      const result = driver.runTurn({
        handle,
        mode: "first",
        content: [
          {
            type: "image",
            mediaType: "image/png",
            data: Buffer.from("validated input").toString("base64"),
          },
        ],
        modelSettings: settings,
        context,
        signal: controller.signal,
      });
      void result.catch(() => {});
      if (outcome === "rpc-rejected" || outcome === "rpc-internal")
        await assert.rejects(result, /start rejected/);
      else await running;
      const input = JSON.parse(await readFile(marker, "utf8"));
      assert.equal(input[0].type, "localImage");
      const path = input[0].path;
      if (outcome !== "rpc-rejected")
        assert.equal(await readFile(path, "utf8"), "validated input");
      if (outcome === "interrupt-rejected") controller.abort();
      if (
        [
          "failed",
          "error",
          "malformed",
          "rpc-rejected",
          "rpc-internal",
          "interrupt-rejected",
        ].includes(outcome)
      )
        await assert.rejects(result);
      else await result;
      if (outcome === "error" || outcome === "rpc-internal") {
        await stat(path); // A rejected RPC/stream is not proof that the process stopped.
        await driver.close();
      }
      if (outcome === "interrupt-rejected" || outcome === "malformed")
        assert.equal(driver.ready, false);
      await assert.rejects(stat(path), { code: "ENOENT" });
      if (outcome === "rpc-rejected") {
        const data = Buffer.alloc(3 * 1024 * 1024, 7).toString("base64");
        for (let index = 0; index < 12; index++) {
          await assert.rejects(
            driver.runTurn({
              handle,
              mode: "resume",
              content: Array.from({ length: 4 }, () => ({
                type: "image" as const,
                mediaType: "image/png" as const,
                data,
              })),
              modelSettings: settings,
              context,
              signal: new AbortController().signal,
            }),
            /start rejected/,
          );
        }
        assert.deepEqual(await readdir(images.directory), []);
      }
    },
  );
}

test("Codex pure-image history is projected without bytes or paths", () => {
  const events = mapItemEvents(
    {
      type: "userMessage",
      id: "image",
      content: [
        { type: "localImage", path: "/private/image.png" },
        { type: "image", url: "data:image/png;base64,PRIVATE" },
      ],
    } as Parameters<typeof mapItemEvents>[0],
    () => "child",
    "snapshot",
  );
  assert.deepEqual(events, [
    { type: "user.message", id: "image", text: "", imageCount: 2 },
  ]);
});

test("a provider exit during image preparation cleans the unsubmitted batch", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "racco-image-exit-race-"));
  await mkdir(join(directory, "state"));
  const pidFile = join(directory, "pid");
  await writeFile(
    join(directory, "codex"),
    `#!/usr/bin/env node
const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));
const lines=require('node:readline').createInterface({input:process.stdin});
lines.on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;if(!['initialize','thread/start'].includes(m.method))return process.stdout.write(JSON.stringify({id:m.id,error:{code:-32601,message:'undeclared RPC'}})+'\\n');const result=m.method==='thread/start'?{thread:{id:'root',cwd:m.params.cwd}}:{userAgent:'racco/0.160.0 test',codexHome:'/tmp/codex-test',platformFamily:'unix',platformOs:'linux'};process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');});
`,
    { mode: 0o700 },
  );
  const previousPath = process.env.PATH;
  process.env.PATH = `${directory}:${previousPath}`;
  let exited!: () => void;
  const closed = new Promise<void>((resolve) => {
    exited = resolve;
  });
  const originalExit = CodexAppServerClient.prototype.onProcessExit;
  t.mock.method(
    CodexAppServerClient.prototype,
    "onProcessExit",
    function (this: CodexAppServerClient, listener: () => void) {
      originalExit.call(this, () => {
        listener();
        exited();
      });
    },
  );
  const images = await TemporaryImages.open(
    join(directory, "state"),
    { warn() {} },
    directory,
  );
  const create = images.create.bind(images);
  let created!: (batch: Awaited<ReturnType<typeof create>>) => void,
    release!: () => void;
  const ready = new Promise<Awaited<ReturnType<typeof create>>>((resolve) => {
    created = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  images.create = async (content) => {
    const batch = await create(content);
    created(batch);
    await gate;
    return batch;
  };
  const driver = new CodexDriver({ info() {}, warn() {} }, images);
  let task: Promise<void> | undefined;
  t.after(async () => {
    release();
    process.env.PATH = previousPath;
    await driver.close();
    await task?.catch(() => {});
    await images.close();
    await rm(directory, { recursive: true, force: true });
  });
  await driver.start();
  const settings = { modelId: "test", reasoningEffort: null };
  const handle = await driver.createSession({
    raccoSessionId: "race",
    cwd: directory,
    modelSettings: settings,
  });
  task = driver.runTurn({
    handle,
    mode: "first",
    content: [{ type: "image", mediaType: "image/png", data: "aW1hZ2U=" }],
    modelSettings: settings,
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
  void task.catch(() => {});
  const batch = await ready;
  process.kill(Number(await readFile(pidFile, "utf8")), "SIGKILL");
  await closed;
  release();
  await assert.rejects(task, /unavailable/);
  await assert.rejects(stat(batch.paths[0]), { code: "ENOENT" });
});
