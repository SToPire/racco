import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "./config.js";

test("resolves a configured state directory relative to the config file", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "racco-config-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const configPath = join(directory, "racco.config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      host: "127.0.0.1",
      port: 7331,
      stateDir: "state",
    }),
  );

  const config = await loadConfig(configPath);

  assert.equal(config.stateDir, join(directory, "state"));
  assert.deepEqual(Object.keys(config).sort(), ["host", "port", "stateDir"]);

  await writeFile(configPath, JSON.stringify({ projectRoots: [directory] }));
  await assert.rejects(
    loadConfig(configPath),
    /Unrecognized key.*projectRoots/,
  );
});
