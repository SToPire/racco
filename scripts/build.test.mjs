import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { buildInfo, verificationInfo } from "./lib/build-info.mjs";
import { run } from "./lib/process.mjs";

test("artifact and verification digests track actual edits, additions and deletions", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "racco-digest-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, { cwd: directory, stdio: "pipe" });
  git("init", "-q");
  await mkdir(join(directory, "src"));
  await mkdir(join(directory, "scripts"));
  await writeFile(
    join(directory, ".gitignore"),
    "dist/\nnode_modules/\n.tmp/\n",
  );
  await writeFile(join(directory, "src/app.ts"), "export const value = 1;\n");
  await writeFile(join(directory, "src/app.test.ts"), "first test\n");
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.com",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "-qm",
    "fixture",
  );
  const first = await buildInfo(directory);
  assert.match(first.sourceRevision, /^[a-f0-9]{40}$/);
  assert.equal("verificationDigest" in first, false);
  assert.notEqual(first.id, (await buildInfo(directory)).id);
  let previous = await verificationInfo(directory);
  for (const [path, content] of [
    ["src/app.test.ts", "changed test"],
    ["scripts/doctor.mjs", "diagnostics only"],
  ]) {
    await writeFile(join(directory, path), content);
    const next = await verificationInfo(directory);
    assert.equal(next.sourceDigest, previous.sourceDigest, path);
    assert.notEqual(next.verificationDigest, previous.verificationDigest, path);
    previous = next;
  }
  for (const [path, content] of [
    ["src/app.ts", "export const value = 2;"],
    ["src/new.ts", "export const added = true;"],
  ]) {
    await writeFile(join(directory, path), content);
    const next = await verificationInfo(directory);
    assert.notEqual(next.sourceDigest, previous.sourceDigest, path);
    assert.notEqual(next.verificationDigest, previous.verificationDigest, path);
    previous = next;
  }
  await rm(join(directory, "src/app.ts"));
  const deleted = await verificationInfo(directory);
  assert.notEqual(deleted.sourceDigest, previous.sourceDigest);
  assert.notEqual(deleted.verificationDigest, previous.verificationDigest);
  for (const path of ["dist", "node_modules", ".tmp"]) {
    await mkdir(join(directory, path));
    await writeFile(join(directory, path, "generated.js"), "output");
  }
  const generated = await verificationInfo(directory);
  assert.equal(generated.sourceDigest, deleted.sourceDigest);
  assert.equal(generated.verificationDigest, deleted.verificationDigest);
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
