import assert from "node:assert/strict";
import { test } from "node:test";
import { scheduleGitRead } from "./git-request";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const signal = () => new AbortController().signal;

test("Git reads serialize across operation kinds within a Worktree", async () => {
  const pending = deferred<number>();
  const calls: string[] = [];
  const first = scheduleGitRead("/serialize", "changes", signal(), () => {
    calls.push("changes");
    return pending.promise;
  });
  const second = scheduleGitRead(
    "/serialize",
    "commits",
    signal(),
    async () => {
      calls.push("commits");
      return 2;
    },
  );
  assert.deepEqual(calls, ["changes"]);
  pending.resolve(1);
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.deepEqual(calls, ["changes", "commits"]);
});

test("pending reads retain only the latest intent of each kind", async () => {
  const pending = deferred<number>();
  const calls: string[] = [];
  const first = scheduleGitRead(
    "/latest",
    "changes",
    signal(),
    () => pending.promise,
  );
  const old = scheduleGitRead("/latest", "commit", signal(), async () => {
    calls.push("old");
    return 2;
  });
  const rejected = assert.rejects(old, { name: "AbortError" });
  const newest = scheduleGitRead("/latest", "commit", signal(), async () => {
    calls.push("newest");
    return 3;
  });
  await rejected;
  pending.resolve(1);
  assert.deepEqual(await Promise.all([first, newest]), [1, 3]);
  assert.deepEqual(calls, ["newest"]);
});

test("canceling an active read does not release the slot until the task settles", async () => {
  const pending = deferred<number>();
  const controller = new AbortController();
  let started = false;
  const first = scheduleGitRead(
    "/cancel",
    "commits",
    controller.signal,
    () => pending.promise,
  );
  const rejected = assert.rejects(first, { name: "AbortError" });
  const next = scheduleGitRead("/cancel", "commit", signal(), async () => {
    started = true;
    return 2;
  });
  controller.abort();
  assert.equal(started, false);
  pending.resolve(1);
  await rejected;
  assert.equal(await next, 2);
});

test("canceling queued reads removes them without affecting another Worktree", async () => {
  const pending = deferred<number>();
  const first = scheduleGitRead(
    "/queue-cancel",
    "changes",
    signal(),
    () => pending.promise,
  );
  const controller = new AbortController();
  const queued = scheduleGitRead(
    "/queue-cancel",
    "commits",
    controller.signal,
    async () => {
      throw new Error("must not run");
    },
  );
  const rejected = assert.rejects(queued, { name: "AbortError" });
  controller.abort();
  await rejected;
  assert.equal(
    await scheduleGitRead("/independent", "changes", signal(), async () => 5),
    5,
  );
  pending.resolve(1);
  assert.equal(await first, 1);
});
