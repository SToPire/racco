import { spawn, execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile, access } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

/** Own one compiled daemon, including its configuration, project and state. */
export async function isolatedServer({
  buildDirectory = resolve(".tmp/check-build"),
  environment = {},
} = {}) {
  const entry = join(buildDirectory, "server/index.js");
  await access(entry); // Deliberately no source/tsx fallback.
  const directory = await mkdtemp(join(tmpdir(), "racco-smoke-"));
  const cwd = join(directory, "project");
  let child, exited, baseUrl;
  let log = "";
  try {
    await mkdir(cwd);
    await mkdir(join(directory, "runtime"), { mode: 0o700 });
    await promisify(execFile)("git", ["init", "-q", cwd]);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  async function stop() {
    if (!child) return;
    const running = child;
    const kill = (signal) => {
      try {
        process.kill(-running.pid, signal);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    };
    if (running.pid && running.exitCode === null && running.signalCode === null)
      kill("SIGTERM");
    const timeout = setTimeout(() => kill("SIGKILL"), 5000);
    try {
      await exited;
    } finally {
      clearTimeout(timeout);
      child = undefined;
    }
  }
  async function start() {
    if (child) throw new Error("Isolated daemon is already started");
    const reservation = createServer();
    await new Promise((resolve, reject) => {
      reservation.once("error", reject);
      reservation.listen(0, "127.0.0.1", resolve);
    });
    const port = reservation.address().port;
    await new Promise((resolve, reject) =>
      reservation.close((error) => (error ? reject(error) : resolve())),
    );
    baseUrl = `http://127.0.0.1:${port}`;
    await writeFile(
      join(directory, "racco.config.json"),
      JSON.stringify({
        host: "127.0.0.1",
        port,
        stateDir: join(directory, "state"),
        worktreeRoot: join(directory, "worktrees"),
      }),
    );
    log = "";
    child = spawn(process.execPath, [entry], {
      cwd: directory,
      env: {
        ...process.env,
        XDG_RUNTIME_DIR: join(directory, "runtime"),
        ...environment,
      },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const running = child;
    let spawnError;
    running.on("error", (error) => {
      spawnError = error;
    });
    exited = new Promise((resolve) => running.once("close", resolve));
    for (const stream of [running.stdout, running.stderr])
      stream.on("data", (data) => {
        log = (log + data).slice(-16000);
      });
    try {
      const deadline = Date.now() + 45000;
      while (Date.now() < deadline) {
        if (spawnError) throw spawnError;
        if (running.exitCode !== null || running.signalCode !== null)
          throw new Error(`Isolated daemon exited: ${log}`);
        try {
          const response = await fetch(`${baseUrl}/api/diagnostics`, {
            signal: AbortSignal.timeout(1000),
          });
          if (
            response.ok &&
            (await response.json()).process.pid === running.pid
          )
            return baseUrl;
        } catch {
          /* Startup still in progress; PID check excludes another listener. */
        }
        await delay(50);
      }
      throw new Error(`Isolated daemon startup timed out: ${log}`);
    } catch (error) {
      await stop();
      throw error;
    }
  }
  return {
    directory,
    cwd,
    start,
    stop,
    get baseUrl() {
      return baseUrl;
    },
    async close() {
      try {
        await stop();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}
