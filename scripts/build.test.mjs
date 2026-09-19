import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildInfo } from "./lib/build-info.mjs";
import { run } from "./lib/process.mjs";

test("build metadata identifies actual source inputs", async () => {
  const first = await buildInfo();
  const second = await buildInfo();
  assert.equal(first.sourceDigest, second.sourceDigest);
  assert.notEqual(first.id, second.id);
  assert.match(first.sourceRevision, /^[a-f0-9]{40}$/);
});

test("command runner rejects failed commands and preserves literal arguments", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "racco-command-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, "result");
  await writeFile(output, "");
  const literal = "literal $(not-a-command) `also-not-a-command`";
  await run(
    process.execPath,
    [
      "-e",
      'require("node:fs").writeFileSync(process.argv[1], process.argv[2])',
      output,
      literal,
    ],
    { stdio: "pipe" },
  );
  assert.equal(await readFile(output, "utf8"), literal);
  await assert.rejects(
    run(process.execPath, ["-e", "process.exit(17)"], { stdio: "pipe" }),
    /17/,
  );
});

test("publishing replaces stale outputs instead of merging generated directories", async (t) => {
  const { mkdir, access } = await import("node:fs/promises");
  const { publishBuild } = await import("./lib/publish-build.mjs");
  const directory = await mkdtemp(join(tmpdir(), "racco-publish-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, "output");
  const stage = join(directory, "stage");
  await mkdir(output);
  await mkdir(stage);
  await writeFile(join(output, "obsolete.js"), "old");
  await writeFile(join(stage, "current.js"), "new");
  await publishBuild(stage, output);
  await assert.rejects(access(join(output, "obsolete.js")), { code: "ENOENT" });
  assert.equal(await readFile(join(output, "current.js"), "utf8"), "new");
});

test("failed build publication restores the preceding output", async (t) => {
  const { mkdir } = await import("node:fs/promises");
  const { publishBuild } = await import("./lib/publish-build.mjs");
  const directory = await mkdtemp(join(tmpdir(), "racco-rollback-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, "output");
  await mkdir(output);
  await writeFile(join(output, "current.js"), "working");
  await assert.rejects(publishBuild(join(directory, "missing-stage"), output), {
    code: "ENOENT",
  });
  assert.equal(await readFile(join(output, "current.js"), "utf8"), "working");
});
