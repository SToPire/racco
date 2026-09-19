import { test as base, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ProjectEntry, SessionSummary } from "../../src/shared/protocol";

type Racco = {
  url: string;
  projects: ProjectEntry[];
  sessions: SessionSummary[];
  directory: string;
};
export const test = base.extend<{ racco: Racco }>({
  racco: async ({ browserName }, use, testInfo) => {
    const parent = resolve(".tmp/e2e");
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(join(parent, "run-"));
    const ready = join(directory, "ready.json");
    const token = randomUUID();
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "test/fixtures/server.ts",
        "--directory",
        directory,
        "--build-info",
        resolve(".tmp/check-build/build-info.json"),
        "--web-root",
        resolve(".tmp/check-build/web"),
        "--ready-file",
        ready,
        "--token",
        token,
      ],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    );
    let log = `Browser: ${browserName}\n`;
    child.stdout.on("data", (data) => {
      log += data.toString();
    });
    child.stderr.on("data", (data) => {
      log += data.toString();
    });
    let spawnError: Error | undefined;
    child.on("error", (error) => {
      spawnError = error;
    });
    const exited = new Promise<void>((done) =>
      child.once("exit", () => done()),
    );
    try {
      let racco: Racco | undefined;
      for (let i = 0; i < 100; i++) {
        if (spawnError) throw spawnError;
        if (child.exitCode !== null) throw new Error(`Fixture exited: ${log}`);
        const info = await readFile(ready, "utf8")
          .then(JSON.parse)
          .catch((error) => {
            if (error.code === "ENOENT") return null;
            throw error;
          });
        if (info?.token === token) {
          racco = info;
          break;
        }
        await delay(100);
      }
      if (!racco) throw new Error(`Fixture startup timed out: ${log}`);
      await use(racco);
    } finally {
      child.kill("SIGTERM");
      const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
      await exited;
      clearTimeout(timeout);
      await writeFile(testInfo.outputPath("server.log"), log);
      await rm(directory, { recursive: true, force: true });
    }
  },
  baseURL: async ({ racco }, use) => {
    await use(racco.url);
  },
});
export { expect };
