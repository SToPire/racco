import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { startDevelopment } from "./dev.mjs";
import { root } from "./lib/process.mjs";

test("development requires exactly one explicit backend mode", async () => {
  await assert.rejects(startDevelopment(), /Choose --fixture or --backend/);
  await assert.rejects(
    startDevelopment({ fixture: true, backend: "http://127.0.0.1:7331" }),
    /Choose --fixture or --backend/,
  );
});

test("development proxies an explicit backend without owning its lifetime", async () => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ realBackend: true }));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const backend = `http://127.0.0.1:${server.address().port}`;
  let development;
  try {
    development = await startDevelopment({ backend });
    assert.equal(development.mode, "backend");
    assert.deepEqual(
      await (await fetch(new URL("/api/health", development.web[0]))).json(),
      { realBackend: true },
    );
    await development.close();
    development = undefined;
    assert.equal((await (await fetch(backend)).json()).realBackend, true);
  } finally {
    await development?.close();
    await new Promise((done) => server.close(done));
  }
});

test("fixture development serves source and API without a preview build or user service", async () => {
  const runtime = await mkdtemp(join(tmpdir(), "racco-dev-test-"));
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "scripts/dev.mjs", "--fixture"],
    {
      cwd: root,
      env: { ...process.env, XDG_RUNTIME_DIR: runtime },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const exited = once(child, "exit");
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const lines = createInterface({ input: child.stdout });
  try {
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Development startup timed out: ${stderr}`)),
        15000,
      );
      child.once("error", reject);
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Development exited ${code}: ${stderr}`));
      });
      lines.on("line", (line) => {
        if (line.startsWith('{"mode":')) {
          clearTimeout(timer);
          resolve(JSON.parse(line));
        }
      });
    });
    assert.equal(ready.mode, "fixture");
    assert.equal(
      (await (await fetch(new URL("/api/health", ready.web[0]))).json()).ok,
      true,
    );
    const source = await fetch(new URL("/src/web/main.tsx", ready.web[0]));
    assert.equal(source.status, 200);
    assert.match(await source.text(), /createRoot/);
  } finally {
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    const [code, signal] = await exited;
    clearTimeout(timer);
    assert.equal(signal, null, `Fixture shutdown required ${signal}`);
    assert.equal(code, 143);
    lines.close();
    await rm(runtime, { recursive: true, force: true });
  }
});
