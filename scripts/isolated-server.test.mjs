import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isolatedServer } from "./lib/isolated-server.mjs";

test("isolated daemon owns config/state/project and waits for shutdown before cleanup", async (t) => {
  const buildDirectory = await mkdtemp(
    join(tmpdir(), "racco-daemon-contract-"),
  );
  t.after(() => rm(buildDirectory, { recursive: true, force: true }));
  await mkdir(join(buildDirectory, "server"));
  // Lifecycle contract fixture only; compiled production behavior has its own smoke.
  await writeFile(
    join(buildDirectory, "server/index.js"),
    `
const {createServer}=require('node:http');
const {readFileSync,writeFileSync}=require('node:fs');
const config=JSON.parse(readFileSync('racco.config.json','utf8'));
const server=createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({process:{pid:process.pid},config}));});
server.listen(config.port,config.host);
process.on('SIGTERM',()=>{writeFileSync('closed','yes');server.close();});
`,
  );
  const server = await isolatedServer({ buildDirectory });
  const directory = server.directory;
  try {
    await server.start();
    const first = await (
      await fetch(server.baseUrl + "/api/diagnostics")
    ).json();
    assert.equal(first.config.stateDir, join(directory, "state"));
    assert.equal(first.config.worktreeRoot, join(directory, "worktrees"));
    assert.notEqual(server.cwd, process.cwd());
    await access(join(server.cwd, ".git"));
    await server.stop();
    await access(join(directory, "closed"));
    await server.start();
    const second = await (
      await fetch(server.baseUrl + "/api/diagnostics")
    ).json();
    assert.notEqual(first.process.pid, second.process.pid);
    assert.equal(first.config.stateDir, second.config.stateDir);
  } finally {
    await server.close();
  }
  await assert.rejects(access(directory), { code: "ENOENT" });
});

test("isolated daemon rejects missing compiled output without source fallback", async () => {
  await assert.rejects(
    isolatedServer({ buildDirectory: "/nonexistent-racco-build" }),
    { code: "ENOENT" },
  );
});

test("native smoke cleanup removes owned native history even without a managed session", async (t) => {
  const { createServer } = await import("node:http");
  const { cleanupSmokeSessions } = await import("./lib/smoke-target.mjs");
  const removed = [];
  const requests = [];
  const server = createServer(async (request, response) => {
    requests.push(request.url);
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/projects")
      return response.end(
        JSON.stringify([
          {
            projectId: "owned-project",
            path: "/tmp/owned-smoke",
          },
        ]),
      );
    if (request.url.startsWith("/api/worktrees/native-sessions")) {
      const next = new URL(request.url, "http://localhost").searchParams.has(
        "cursor",
      );
      return response.end(
        JSON.stringify({
          sessions: [{ providerSessionId: next ? "second" : "first" }],
          nextCursor: next ? null : "next",
        }),
      );
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    removed.push(JSON.parse(body));
    response.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await cleanupSmokeSessions(`http://127.0.0.1:${server.address().port}`, {
    provider: "codex",
    cwd: "/tmp/owned-smoke",
  });
  assert.deepEqual(
    removed,
    ["first", "second"].map((providerSessionId) => ({
      provider: "codex",
      providerSessionId,
      projectId: "owned-project",
      path: "/tmp/owned-smoke",
    })),
  );
  assert.equal(requests[2].includes("cursor=next"), true);
});
