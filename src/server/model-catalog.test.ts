import assert from "node:assert/strict";
import test from "node:test";
import type { AgentDriver } from "./drivers/driver.js";
import { fixtureModelCatalog } from "../../test/model-catalog.js";
import { ModelCatalogCache } from "./model-catalog.js";

test("catalog queries coalesce per cwd and invalidation discards cached results", async () => {
  const cache = new ModelCatalogCache();
  let calls = 0;
  const driver: Pick<AgentDriver, "provider" | "listModels"> = {
    provider: "codex",
    async listModels() {
      calls++;
      return fixtureModelCatalog();
    },
  };
  const first = cache.get(driver, "/a");
  assert.equal(cache.get(driver, "/a"), first);
  await first;
  await cache.get(driver, "/a");
  assert.equal(calls, 1);
  await cache.get(driver, "/b");
  assert.equal(calls, 2);
  cache.invalidate("codex", "/a");
  await cache.get(driver, "/a");
  assert.equal(calls, 3);
  cache.close();
});

test("timeout cancels discovery and permits a later attempt", async () => {
  const cache = new ModelCatalogCache(10);
  let aborted = false;
  const driver: Pick<AgentDriver, "provider" | "listModels"> = {
    provider: "claude",
    async listModels({ signal }: { signal: AbortSignal }) {
      return new Promise<never>((_, reject) =>
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(signal.reason);
          },
          { once: true },
        ),
      );
    },
  };
  await assert.rejects(cache.get(driver, "/a"), /超时/);
  assert.equal(aborted, true);
  driver.listModels = async () => fixtureModelCatalog();
  assert.equal((await cache.get(driver, "/a")).models.length, 3);
  cache.close();
});
