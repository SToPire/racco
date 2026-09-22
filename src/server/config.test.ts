import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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
      worktreeRoot: "trees",
    }),
  );

  const config = await loadConfig(configPath);

  assert.equal(config.stateDir, join(directory, "state"));
  assert.equal(config.worktreeRoot, join(directory, "trees"));
  assert.deepEqual(Object.keys(config).sort(), [
    "host",
    "port",
    "stateDir",
    "worktreeRoot",
  ]);

  await writeFile(configPath, JSON.stringify({ projectRoots: [directory] }));
  await assert.rejects(
    loadConfig(configPath),
    /Unrecognized key.*projectRoots/,
  );
});

test("defaults the worktree root under the XDG data home", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "racco-config-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const configPath = join(directory, "racco.config.json");
  await writeFile(
    configPath,
    JSON.stringify({ host: "127.0.0.1", port: 7331 }),
  );

  const previousDataHome = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = join(directory, "data");
  t.after(() => {
    if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousDataHome;
  });

  const config = await loadConfig(configPath);

  assert.equal(
    config.worktreeRoot,
    join(directory, "data", "racco", "worktrees"),
  );
});

test("canonicalizes a worktree root reached through a symlink", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "racco-config-link-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const checkout = join(directory, "checkout");
  await mkdir(checkout);
  // The README installs the checkout as a symlink; Git canonicalizes the paths
  // it records, so the root must be canonical before it is used as identity.
  const link = join(directory, "racco");
  await symlink(checkout, link);

  const configPath = join(directory, "racco.config.json");
  await writeFile(
    configPath,
    JSON.stringify({ host: "127.0.0.1", port: 7331, worktreeRoot: link }),
  );

  const config = await loadConfig(configPath);

  assert.equal(config.worktreeRoot, checkout);
});
