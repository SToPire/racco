import assert from "node:assert/strict";
import test from "node:test";
import { WorktreeCatalogCache } from "./cache.js";
import type { DerivedCatalog } from "./derive.js";

const catalog: DerivedCatalog = {
  worktrees: ["/repo", "/linked"].map((path, index) => ({
    path,
    name: path.slice(1),
    kind: index === 0 ? "primary" : "linked",
    branch: "main",
    head: "abc",
    available: true,
    locked: false,
    prunable: false,
    removable: index !== 0,
  })),
  degradedReason: null,
};

test("refresh preserves the last complete catalog across degraded and failed reads", async () => {
  let outcome: DerivedCatalog | Error = catalog;
  let calls = 0;
  const cache = new WorktreeCatalogCache(async () => {
    calls++;
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
  assert.deepEqual(await cache.get("/repo"), catalog);
  outcome = {
    worktrees: [catalog.worktrees[0]],
    degradedReason: "git unavailable",
  };
  assert.deepEqual(await cache.refresh("/repo"), {
    ...catalog,
    degradedReason: "git unavailable",
  });
  outcome = new Error("malformed listing");
  assert.deepEqual(await cache.refresh("/repo"), {
    ...catalog,
    degradedReason: "malformed listing",
  });
  outcome = catalog;
  assert.equal((await cache.get("/repo")).degradedReason, "malformed listing");
  assert.equal(calls, 3, "ordinary reads do not poll Git");
  assert.deepEqual(await cache.refresh("/repo"), catalog);
});

test("concurrent reads coalesce and an older read cannot replace a mutation result", async () => {
  let release!: (catalog: DerivedCatalog) => void;
  const cache = new WorktreeCatalogCache(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const first = cache.get("/repo");
  assert.equal(cache.refresh("/repo"), first);
  assert.equal(cache.get("/repo"), first);
  const updated = { ...catalog, worktrees: [catalog.worktrees[0]] };
  cache.set("/repo", updated);
  release(catalog);
  await first;
  assert.deepEqual(await cache.get("/repo"), updated);
});

test("an initial failure stays an error until an explicit successful refresh", async () => {
  let fails = true;
  const cache = new WorktreeCatalogCache(async () => {
    if (fails) throw new Error("empty listing");
    return catalog;
  });
  await assert.rejects(cache.get("/repo"), /empty listing/);
  fails = false;
  await assert.rejects(cache.get("/repo"), /empty listing/);
  assert.deepEqual(await cache.refresh("/repo"), catalog);
});
