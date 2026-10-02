import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { openRaccoStateDatabase } from "./database.js";
import { CURRENT_SCHEMA_VERSION } from "./schema.js";

async function processes(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "racco-lock-"));
  const children: { child: ChildProcess; exited: Promise<unknown[]> }[] = [];
  t.after(async () => {
    for (const { child, exited } of children) {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await exited;
    }
    await rm(directory, { force: true, recursive: true });
  });
  return {
    directory,
    start(mode = "normal") {
      const child = fork(
        new URL("../../../test/fixtures/state-lock.mjs", import.meta.url),
        [directory, mode],
        {
          execArgv: ["--import", "tsx"],
          stdio: ["ignore", "ignore", "inherit", "ipc"],
        },
      );
      const exited = once(child, "exit");
      children.push({ child, exited });
      return {
        child,
        exited,
        async next() {
          const [message] = await once(child, "message", {
            signal: AbortSignal.timeout(10_000),
          });
          return message as { type: string; message?: string };
        },
      };
    },
  };
}

test("keeps the lock inode and releases ownership on close or database failure", async (t) => {
  const { directory } = await processes(t);

  const first = openRaccoStateDatabase(directory);
  const lockPath = join(directory, "racco.lock");
  const inode = statSync(lockPath).ino;
  assert.throws(
    () => openRaccoStateDatabase(directory),
    /Another Racco process/,
  );
  first.close();

  const reopened = openRaccoStateDatabase(directory);
  first.close();
  assert.throws(
    () => openRaccoStateDatabase(directory),
    /Another Racco process/,
  );
  reopened.database.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION - 1}`);
  reopened.close();
  assert.throws(
    () => openRaccoStateDatabase(directory),
    /schema .* is unsupported/,
  );
  // A second schema error proves the first failed open released its lock.
  assert.throws(
    () => openRaccoStateDatabase(directory),
    /schema .* is unsupported/,
  );
  assert.equal(existsSync(lockPath), true);
  assert.equal(statSync(lockPath).ino, inode);
});

test("two processes cannot both open state across the empty lock-file window", async (t) => {
  const fixture = await processes(t);
  const first = fixture.start("pause-after-open");
  assert.deepEqual(await first.next(), { type: "opened-lock-file" });
  const lockPath = join(fixture.directory, "racco.lock");
  const inode = statSync(lockPath).ino;
  assert.equal(await readFile(lockPath, "utf8"), "");

  const second = fixture.start();
  assert.deepEqual(await second.next(), { type: "opened-database" });
  const result = first.next();
  await writeFile(join(fixture.directory, "resume"), "");
  assert.deepEqual(await result, {
    type: "rejected",
    message: "Another Racco process is using this state directory",
  });
  await first.exited;
  assert.equal(statSync(lockPath).ino, inode);
  assert.throws(
    () => openRaccoStateDatabase(fixture.directory),
    /Another Racco process/,
  );
  second.child.send("close");
  await second.exited;
  const reopened = openRaccoStateDatabase(fixture.directory);
  reopened.close();
  assert.equal(statSync(lockPath).ino, inode);
});

test("a missing flock command fails clearly without retaining a lock descriptor", async (t) => {
  const { directory } = await processes(t);
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = join(directory, "missing-bin");
    assert.throws(
      () => openRaccoStateDatabase(directory),
      /Could not run flock for the Racco state lock:.*ENOENT/,
    );
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
  const lockPath = join(directory, "racco.lock");
  for (const descriptor of readdirSync("/proc/self/fd")) {
    const path = join("/proc/self/fd", descriptor);
    if (existsSync(path)) assert.notEqual(readlinkSync(path), lockPath);
  }
  const reopened = openRaccoStateDatabase(directory);
  reopened.close();
});

test("a new process acquires the same lock inode after its owner is killed", async (t) => {
  const fixture = await processes(t);
  const first = fixture.start();
  assert.deepEqual(await first.next(), { type: "opened-database" });
  const lockPath = join(fixture.directory, "racco.lock");
  const inode = statSync(lockPath).ino;
  first.child.kill("SIGKILL");
  await first.exited;

  const second = fixture.start();
  assert.deepEqual(await second.next(), { type: "opened-database" });
  assert.equal(statSync(lockPath).ino, inode);
  second.child.send("close");
  await second.exited;
});
