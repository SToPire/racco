import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveProjectDirectory } from "./project-path.js";

test("canonicalizes imported project directories and rejects invalid paths", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "racco-path-"));
  t.after(() => rm(fixture, { force: true, recursive: true }));

  const root = join(fixture, "root");
  const child = join(root, "child");
  const alias = join(fixture, "alias");
  const file = join(fixture, "file.txt");
  await mkdir(child, { recursive: true });
  await symlink(child, alias, "dir");
  await writeFile(file, "not a directory");

  assert.equal(await resolveProjectDirectory(alias), await realpath(child));
  assert.equal(await resolveProjectDirectory("relative/project"), undefined);
  assert.equal(await resolveProjectDirectory(file), undefined);
  assert.equal(await resolveProjectDirectory(join(root, "missing")), undefined);
  assert.equal(await resolveProjectDirectory("/"), undefined);
});
