import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseWorktreeList } from "./porcelain.js";

async function fixture(name: string): Promise<string> {
  return readFile(
    fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)),
    "utf8",
  );
}

test("parses a plain listing with the repository checkout and a linked branch", async () => {
  const outcome = parseWorktreeList(await fixture("plain.txt"));
  assert.equal(outcome.kind, "ok");
  if (outcome.kind !== "ok") return;
  assert.equal(outcome.worktrees.length, 3);

  const [primary, linked, detached] = outcome.worktrees;
  assert.equal(primary.path, "/home/dev/repo");
  assert.equal(primary.branch, "main");
  assert.equal(primary.detached, false);

  assert.equal(linked.path, "/home/dev/worktrees/repo/feature");
  assert.equal(linked.branch, "feat/feature");

  assert.equal(detached.path, "/home/dev/worktrees/repo/spike");
  assert.equal(detached.detached, true);
  assert.equal(detached.branch, null);
});

test("surfaces bare, locked and prunable markers", async () => {
  const outcome = parseWorktreeList(await fixture("markers.txt"));
  assert.equal(outcome.kind, "ok");
  if (outcome.kind !== "ok") return;
  assert.equal(outcome.worktrees.length, 3);

  assert.equal(outcome.worktrees[0].bare, true);

  assert.equal(outcome.worktrees[1].locked, true);
  assert.equal(outcome.worktrees[1].lockedReason, "work in progress");

  assert.equal(outcome.worktrees[2].prunable, true);
  assert.equal(
    outcome.worktrees[2].prunableReason,
    "gitdir file points to non-existent location",
  );
});

test("reports an empty listing as empty, never as a valid empty catalog", () => {
  const outcome = parseWorktreeList("");
  assert.equal(outcome.kind, "empty");
});

test("reports a key-value line outside any block as malformed", () => {
  const outcome = parseWorktreeList("HEAD abc\n");
  assert.equal(outcome.kind, "malformed");
});

test("rejects a relative worktree path", () => {
  const outcome = parseWorktreeList("worktree relative/path\nHEAD abc\n");
  assert.equal(outcome.kind, "malformed");
});

test("tolerates unknown keys from a future Git release", () => {
  const outcome = parseWorktreeList(
    "worktree /home/dev/repo\nHEAD abc\nbranch refs/heads/main\nfuture-key value\n",
  );
  assert.equal(outcome.kind, "ok");
  if (outcome.kind !== "ok") return;
  assert.equal(outcome.worktrees.length, 1);
  assert.equal(outcome.worktrees[0].branch, "main");
});
