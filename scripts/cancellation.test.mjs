import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { run } from "./lib/process.mjs";
import { withFileLock } from "./lib/file-lock.mjs";

test("command cancellation stops its owned descendant process group", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "racco-cancel-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pidFile = join(directory, "pid");
  const controller = new AbortController();
  const command = `const {spawn}=require('node:child_process'); const fs=require('node:fs'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); fs.writeFileSync(process.argv[1],String(child.pid)); setInterval(()=>{},1000);`;
  const task = run(process.execPath, ["-e", command, pidFile], {
    stdio: "ignore",
    signal: controller.signal,
  });
  const rejected = assert.rejects(task, /cancelled by test/);
  let pid;
  t.after(() => {
    if (pid) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
  });
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      pid = await readFile(pidFile, "utf8")
        .then(Number)
        .catch((error) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
      if (pid) break;
      await delay(20);
    }
    assert.ok(pid);
    controller.abort(new Error("cancelled by test"));
    await rejected;
    let live = true;
    for (let attempt = 0; attempt < 100; attempt++) {
      const state = await readFile(`/proc/${pid}/stat`, "utf8").catch(
        (error) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        },
      );
      live = state !== undefined && !/\) Z /.test(state);
      if (!live) break;
      await delay(20);
    }
    assert.equal(live, false);
  } finally {
    if (!controller.signal.aborted)
      controller.abort(new Error("cancelled by test"));
  }
});

test("operation locks exclude contenders and release after failed actions", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "racco-lock-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "lock");
  let acquired;
  const ready = new Promise((resolve) => {
    acquired = resolve;
  });
  let release;
  const blocker = new Promise((resolve) => {
    release = resolve;
  });
  const first = withFileLock(path, async () => {
    acquired();
    await blocker;
  });
  await ready;
  try {
    await assert.rejects(
      withFileLock(path, () => undefined),
      /75/,
    );
  } finally {
    release();
    await first;
  }
  await assert.rejects(
    withFileLock(path, () => {
      throw new Error("action failed");
    }),
    /action failed/,
  );
  assert.equal(await withFileLock(path, () => 42), 42);
});
