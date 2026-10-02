import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { WebSocket } from "ws";
import { root } from "../../scripts/lib/process.mjs";

test(
  "the compiled distribution serves HTTP, WebSocket and persistent state without source or a TS loader",
  { timeout: 45_000 },
  async (t) => {
    const output = join(root, ".tmp/check-build");
    const build = JSON.parse(
      await readFile(join(output, "build-info.json"), "utf8"),
    );
    const directory = await mkdtemp(join(tmpdir(), "racco-compiled-"));
    const artifact = join(directory, "artifact");
    const runtime = join(directory, "runtime");
    const bin = join(directory, "bin");
    let child;
    let closed;
    let socket;
    t.after(async () => {
      socket?.terminate();
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        const force = setTimeout(() => child.kill("SIGKILL"), 4000);
        await closed;
        clearTimeout(force);
      }
      await rm(directory, { recursive: true, force: true });
    });
    // The runtime tree has no src directory; even accidental .ts imports fail.
    await cp(output, artifact, { recursive: true });
    await symlink(join(root, "node_modules"), join(artifact, "node_modules"));
    await writeFile(join(artifact, "package.json"), '{"type":"module"}\n');
    await Promise.all(
      [runtime, bin, join(directory, "home"), join(directory, "xdg")].map(
        (path) => mkdir(path, { mode: 0o700 }),
      ),
    );
    const calls = join(directory, "native-calls.jsonl");
    await writeFile(
      join(bin, "codex"),
      `#!${process.execPath}
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('codex-cli 0.160.0'); process.exit(0); }
const lines = require('node:readline').createInterface({ input: process.stdin });
lines.on('line', line => {
  const message = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(message) + '\\n');
  if (message.method === 'initialized') return;
  const response = message.method === 'initialize'
    ? { id: message.id, result: { userAgent: 'racco/0.160.0 test', codexHome: '/tmp/codex-test', platformFamily: 'unix', platformOs: 'linux' } }
    : { id: message.id, error: { code: -32601, message: 'Unexpected compiled-test RPC: ' + message.method } };
  process.stdout.write(JSON.stringify(response) + '\\n');
});
`,
      { mode: 0o700 },
    );
    const listener = createServer();
    listener.listen(0, "127.0.0.1");
    await once(listener, "listening");
    const { port } = listener.address();
    await new Promise((resolve) => listener.close(resolve));
    const url = `http://127.0.0.1:${port}`;
    const stateDir = join(runtime, "state");
    await writeFile(
      join(runtime, "racco.config.json"),
      JSON.stringify({
        host: "127.0.0.1",
        port,
        stateDir,
        worktreeRoot: join(runtime, "worktrees"),
      }),
    );
    const environment = {
      PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: join(directory, "home"),
      XDG_RUNTIME_DIR: join(directory, "xdg"),
      XDG_CONFIG_HOME: join(directory, "home/config"),
      XDG_STATE_HOME: join(directory, "home/state"),
      XDG_DATA_HOME: join(directory, "home/data"),
    };
    const command = [
      "--no-experimental-strip-types",
      join(artifact, "server/index.js"),
    ];
    let logs = "";
    async function start() {
      child = spawn(process.execPath, command, {
        cwd: runtime,
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
      });
      closed = once(child, "close");
      child.stdout.on("data", (chunk) => {
        logs = (logs + chunk).slice(-20_000);
      });
      child.stderr.on("data", (chunk) => {
        logs = (logs + chunk).slice(-20_000);
      });
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        if (child.exitCode !== null)
          throw new Error(`Compiled server exited: ${logs}`);
        try {
          const response = await fetch(`${url}/api/health`, {
            signal: AbortSignal.timeout(200),
          });
          if (response.ok) return await response.json();
        } catch {
          /* Wait only for the owned process to open its listener. */
        }
        await delay(40);
      }
      throw new Error(`Compiled server did not start: ${logs}`);
    }
    const health = await start();
    assert.equal(health.ok, true);
    assert.equal(health.providers.codex, "ready");
    const diagnostics = await (await fetch(`${url}/api/diagnostics`)).json();
    assert.equal(diagnostics.build.id, build.id);
    assert.equal(diagnostics.process.pid, child.pid);
    assert.equal(diagnostics.storage.stateDir, stateDir);
    const index = await fetch(url);
    assert.equal(index.status, 200);
    assert.match(index.headers.get("content-type"), /text\/html/);
    const html = await index.text();
    const asset = /<script[^>]+src="([^"]+\.js)"/.exec(html)?.[1];
    assert.ok(asset, "built HTML must reference its compiled JavaScript");
    const javascript = await fetch(new URL(asset, url));
    assert.equal(javascript.status, 200);
    assert.match(javascript.headers.get("content-type"), /javascript/);
    assert.ok((await javascript.text()).length > 1000);
    socket = new WebSocket(`${url.replace("http:", "ws:")}/api/ws`, {
      origin: url,
    });
    await once(socket, "open");
    const reply = once(socket, "message");
    socket.send(
      JSON.stringify({ type: "connection.ping", requestId: "compiled-ping" }),
    );
    assert.deepEqual(JSON.parse((await reply)[0].toString()), {
      type: "ack",
      requestId: "compiled-ping",
    });
    socket.close();
    await once(socket, "close");
    socket = undefined;
    const project = join(runtime, "project");
    await mkdir(project);
    await writeFile(join(project, "README.md"), "compiled state check\n");
    const imported = await fetch(`${url}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: url },
      body: JSON.stringify({ path: project }),
    });
    assert.equal(imported.status, 200, await imported.clone().text());
    const entry = await imported.json();
    const oldPid = child.pid;
    child.kill("SIGTERM");
    const [exitCode] = await closed;
    assert.equal(exitCode, 0, logs);
    await start();
    assert.notEqual(child.pid, oldPid);
    const projects = await (await fetch(`${url}/api/projects`)).json();
    assert.equal(
      projects.find((item) => item.projectId === entry.projectId)?.path,
      project,
    );
    const requests = (await readFile(calls, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(
      requests.filter((request) => request.method === "initialize").length,
      2,
    );
    assert.ok(
      requests.every((request) =>
        ["initialize", "initialized"].includes(request.method),
      ),
      "this boundary test never calls a model",
    );
  },
);
