import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deployBuild, productionBuild } from "./lib/deploy-build.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "racco-deploy-"));
  const output = join(directory, "dist");
  await mkdir(join(directory, ".tmp"));
  const script = join(directory, "daemon.cjs");
  await writeFile(
    script,
    `const fs=require('node:fs'); const http=require('node:http');
    const root=process.argv[2]; const id=JSON.parse(fs.readFileSync(root+'/build-info.json')).id;
    const server=http.createServer((req,res)=>res.end(JSON.stringify({backend:id,web:fs.readFileSync(root+'/web.txt','utf8')})));
    server.listen(0,'127.0.0.1',()=>process.send(server.address().port));`,
  );
  async function generate(id) {
    await mkdir(output, { recursive: true });
    await writeFile(join(output, "build-info.json"), JSON.stringify({ id }));
    await writeFile(join(output, "web.txt"), id);
    return { info: { id }, output };
  }
  let child, port;
  const service = {
    async start() {
      child = fork(script, [output], {
        stdio: ["ignore", "ignore", "inherit", "ipc"],
      });
      [port] = await once(child, "message", {
        signal: AbortSignal.timeout(5000),
      });
    },
    async stop() {
      if (!child) return;
      const exited = once(child, "exit");
      child.kill();
      await exited;
      child = undefined;
    },
    async ready(info) {
      assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}`)).json(), {
        backend: info.id,
        web: info.id,
      });
    },
  };
  t.after(async () => {
    await service.stop();
    await rm(directory, { recursive: true, force: true });
  });
  await generate("old");
  await service.start();
  return { output, service, generate, stopped: () => child === undefined };
}

test("production update stops the reader before replacing its web and restarts the matching backend", async (t) => {
  const f = await fixture(t);
  await deployBuild({
    ...f,
    build: async () => {
      assert.equal(f.stopped(), true);
      return f.generate("new");
    },
  });
  await f.service.ready({ id: "new" });
});

for (const failure of ["compile", "startup"])
  test(`failed ${failure} restores the previous backend and web`, async (t) => {
    const f = await fixture(t);
    const ready = f.service.ready;
    f.service.ready = async (info) => {
      if (info.id === "new") throw new Error("startup failed");
      await ready(info);
    };
    await assert.rejects(
      deployBuild({
        ...f,
        build: async () => {
          if (failure === "compile") throw new Error("compile failed");
          return f.generate("new");
        },
      }),
      new RegExp(`${failure} failed`),
    );
    await f.service.ready({ id: "old" });
  });

test("a fresh checkout builds without a config or user bus, but an installed checkout fails closed", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "racco-first-build-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = process.env.PATH;
  let builds = 0;
  try {
    process.env.PATH = directory;
    assert.equal(
      await productionBuild(async () => ++builds, {
        checkout: directory,
        entry: join(directory, "missing"),
      }),
      1,
    );
    await assert.rejects(
      productionBuild(async () => ++builds, {
        checkout: directory,
        entry: directory,
      }),
      /restore the systemd user bus/,
    );
    assert.equal(builds, 1);
    await writeFile(
      join(directory, "systemctl"),
      `#!/bin/sh\nprintf 'ActiveState=active\\nWorkingDirectory=${directory}\\n'\n`,
      { mode: 0o700 },
    );
    await assert.rejects(
      productionBuild(async () => ++builds, {
        checkout: directory,
        entry: directory,
      }),
      /ENOENT.*racco.config.json/,
    );
    assert.equal(builds, 1);
  } finally {
    if (path === undefined) delete process.env.PATH;
    else process.env.PATH = path;
  }
});
