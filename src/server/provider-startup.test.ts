import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildServer } from "./server.js";
import { CodexDriver } from "./drivers/codex/codex-driver.js";
import { FixtureDriver } from "../../test/fixtures/driver.js";

test(
  "an unresponsive initialize leaves health, UI and the other provider usable",
  { timeout: 10_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "racco-startup-"));
    const previousPath = process.env.PATH;
    const previousRuntime = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = directory;
    process.env.PATH = `${directory}:${previousPath}`;
    t.after(async () => {
      process.env.PATH = previousPath;
      if (previousRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = previousRuntime;
      await rm(directory, { recursive: true, force: true });
    });
    const pidFile = join(directory, "pid");
    await writeFile(
      join(directory, "codex"),
      `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.stdin.resume();`,
      { mode: 0o700 },
    );
    const webRoot = join(directory, "web");
    await mkdir(webRoot);
    await writeFile(
      join(webRoot, "index.html"),
      "<title>Racco available</title>",
    );
    const app = await buildServer(
      {
        host: "127.0.0.1",
        allowedHosts: ["127.0.0.1", "localhost", "[::1]"],
        port: 7331,
        stateDir: join(directory, "state"),
        worktreeRoot: join(directory, "worktrees"),
      },
      {
        createDrivers: (log, images) => [
          new CodexDriver(log, images, { initializeMs: 500, requestMs: 500 }),
          new FixtureDriver("claude", join(directory, "claude")),
        ],
        build: {
          schema: 1,
          id: "00000000-0000-4000-8000-000000000000",
          sourceRevision: "a".repeat(40),
          sourceDigest: "a".repeat(64),
          dirty: false,
          builtAt: new Date().toISOString(),
        },
        logger: false,
        webRoot,
      },
    );
    t.after(() => app.close());
    assert.deepEqual((await app.inject("/api/health")).json(), {
      ok: true,
      providers: { codex: "unavailable", claude: "ready" },
    });
    assert.match((await app.inject("/")).body, /Racco available/);
    const pid = Number(await readFile(pidFile, "utf8"));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  },
);
