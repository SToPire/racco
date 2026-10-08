import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  rename,
  symlink,
  access,
  open,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Fastify from "fastify";
import { GitChangesReader, parseStatus, addedDiff } from "./changes.js";
import { GitReadError, gitRead } from "./git.js";
import { gitChangeRoutes } from "./routes.js";
import { parseUnifiedDiff } from "../../shared/file-diff.js";

const exec = promisify(execFile);
async function fixture(t: test.TestContext, commit = true) {
  const root = await mkdtemp(join(tmpdir(), "racco-changes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    exec("git", args, { cwd: root, encoding: "utf8" });
  await git("init", "-q");
  await git("config", "user.name", "Git Test");
  await git("config", "user.email", "test@example.invalid");
  await writeFile(join(root, "tracked.txt"), "original\n");
  await git("add", ".");
  if (commit) await git("commit", "-qm", "base");
  return { root, git, reader: new GitChangesReader() };
}

test("keeps staged and unstaged changes when they cancel relative to HEAD", async (t) => {
  const { root, git, reader } = await fixture(t);
  await writeFile(join(root, "tracked.txt"), "staged\n");
  await git("add", ".");
  await writeFile(join(root, "tracked.txt"), "original\n");
  const listing = await reader.list(root);
  assert.deepEqual(listing.entries.map((entry) => entry.group).sort(), [
    "staged",
    "unstaged",
  ]);
  assert.equal((await git("diff", "HEAD")).stdout, "");
  const staged = await reader.diff(root, "tracked.txt", "staged");
  assert.match(staged.diff, /\+staged/);
  const unstaged = await reader.diff(root, "tracked.txt", "unstaged");
  assert.match(unstaged.diff, /-staged/);
  await writeFile(join(root, "tracked.txt"), "updated again\n");
  assert.match(
    (await reader.diff(root, "tracked.txt", "unstaged")).diff,
    /updated again/,
  );
});

test("unborn cached diff, intent-to-add, ignored and untracked empty files", async (t) => {
  const { root, git, reader } = await fixture(t, false);
  assert.equal((await reader.list(root)).head, null);
  assert.match(
    (await reader.diff(root, "tracked.txt", "staged")).diff,
    /original/,
  );
  await git("commit", "-qm", "base");
  await writeFile(join(root, "intent.txt"), "pending\n");
  await git("add", "-N", "intent.txt");
  await writeFile(join(root, "empty.txt"), "");
  await writeFile(join(root, ".gitignore"), "ignored.txt\n");
  await writeFile(join(root, "ignored.txt"), "hidden");
  const listing = await reader.list(root);
  assert(!listing.entries.some((entry) => entry.path === "ignored.txt"));
  assert(
    !listing.entries.some(
      (entry) => entry.path === "intent.txt" && entry.group === "staged",
    ),
  );
  assert.match(
    (await reader.diff(root, "intent.txt", "unstaged")).diff,
    /pending/,
  );
  assert.equal(
    (await reader.diff(root, "empty.txt", "untracked")).kind,
    "metadata",
  );
});

test("renames expose both sides in one request and paths remain literal", async (t) => {
  const { root, git, reader } = await fixture(t);
  const name = ":(glob)new\nname.txt";
  await rename(join(root, "tracked.txt"), join(root, name));
  await git("add", "-A");
  const listing = await reader.list(root);
  const renamed = listing.entries.find(
    (entry) => entry.oldPath === "tracked.txt",
  )!;
  assert.equal(renamed.path, name);
  const patch = await reader.diff(root, name, "staged");
  assert.equal(patch.oldPath, "tracked.txt");
  assert.equal(
    parseUnifiedDiff(patch.diff).filter((line) => line.kind === "added").length,
    1,
  );
  assert.equal(
    parseUnifiedDiff(patch.diff).filter((line) => line.kind === "removed")
      .length,
    1,
  );
  await assert.rejects(
    reader.diff(root, "../secret", "untracked"),
    (error: unknown) =>
      error instanceof GitReadError && error.statusCode === 400,
  );
  await assert.rejects(
    reader.diff(root, "tracked.txt", "staged"),
    (error: unknown) =>
      error instanceof GitReadError && error.statusCode === 404,
  );
});

test("binary, large, symlink and deleted changes are explicit", async (t) => {
  const { root, reader } = await fixture(t);
  await writeFile(join(root, "binary"), Buffer.from([0, 1, 2]));
  await writeFile(join(root, "large"), Buffer.alloc(2 * 1024 * 1024 + 1, 65));
  const outside = `${root}-outside`;
  await writeFile(outside, "SECRET_CONTENT\n");
  t.after(() => rm(outside, { force: true }));
  await symlink(outside, join(root, "link"));
  await rm(join(root, "tracked.txt"));
  assert.equal((await reader.diff(root, "binary", "untracked")).kind, "binary");
  assert.equal(
    (await reader.diff(root, "large", "untracked")).kind,
    "unavailable",
  );
  const link = await reader.diff(root, "link", "untracked");
  assert(!link.diff.includes("SECRET_CONTENT"));
  assert(link.diff.includes(outside));
  assert.match(link.diff, /new file mode 120000/);
  assert.equal(link.currentFileAvailable, false);
  assert.match(
    (await reader.diff(root, "tracked.txt", "unstaged")).diff,
    /-original/,
  );
});

test("rejects invalid UTF-8 filenames rather than replacing bytes", async (t) => {
  const { root, reader } = await fixture(t);
  const name = Buffer.concat([Buffer.from(`${root}/bad-`), Buffer.from([255])]);
  const handle = await open(name, "w");
  await handle.close();
  await assert.rejects(reader.list(root), /非 UTF-8/);
});

test("root boundary, conflicts and gitlink metadata", async (t) => {
  const { root, git, reader } = await fixture(t);
  await mkdir(join(root, "nested"));
  await assert.rejects(reader.list(join(root, "nested")), /根目录/);
  const blob = (await git("rev-parse", "HEAD:tracked.txt")).stdout.trim();
  await git("update-index", "--force-remove", "tracked.txt");
  const input = `100644 ${blob} 1\ttracked.txt\n100644 ${blob} 2\ttracked.txt\n100644 ${blob} 3\ttracked.txt\n`;
  const child = (await import("node:child_process")).spawn(
    "git",
    ["update-index", "--index-info"],
    { cwd: root },
  );
  const exit = new Promise<void>((resolve, reject) =>
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error("index setup failed")),
    ),
  );
  child.stdin.end(input);
  await exit;
  assert.equal(
    (await reader.diff(root, "tracked.txt", "conflict")).kind,
    "conflict",
  );
  const object = (await git("rev-parse", "HEAD")).stdout.trim();
  await git(
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${object},submodule`,
  );
  const sub = (await reader.list(root)).entries.find(
    (entry) => entry.path === "submodule",
  );
  assert.equal(sub?.submodule, true);
  assert.equal(
    (await reader.diff(root, "submodule", "staged")).kind,
    "submodule",
  );
});

test("external diff and fsmonitor are not executed, concurrent lists coalesce", async (t) => {
  const { root, git, reader } = await fixture(t);
  const script = join(root, "external.sh");
  const marker = join(root, "executed");
  await writeFile(script, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
  await git("config", "diff.external", script);
  await git("config", "core.fsmonitor", script);
  await writeFile(join(root, "tracked.txt"), "changed\n");
  const first = reader.list(root);
  assert.equal(reader.list(root), first);
  await assert.rejects(reader.diff(root, "tracked.txt", "unstaged"), /繁忙/);
  await first;
  assert.match(
    (await reader.diff(root, "tracked.txt", "unstaged")).diff,
    /changed/,
  );
  await assert.rejects(access(marker));
});

test("synthetic diff preserves empty lines, newline marker and quoted filename", () => {
  const diff = addedDiff('new\n"\\file', "first\n\nlast");
  assert.match(diff, /No newline at end of file/);
  assert.equal(
    parseUnifiedDiff(diff).filter((row) => row.kind === "added").length,
    3,
  );
  assert.match(diff, /\\012/);
  assert.throws(() => parseStatus(Buffer.from("unknown\0")), GitReadError);
});

test("routes enforce origin, registered root and strict queries", async (t) => {
  const { root } = await fixture(t);
  const app = Fastify();
  t.after(() => app.close());
  await app.register(gitChangeRoutes, {
    worktreeIsAvailable: async (path) => path === root,
  });
  const url = `/api/worktrees/changes?${new URLSearchParams({ path: root })}`;
  assert.equal((await app.inject(url)).statusCode, 200);
  assert.equal(
    (await app.inject({ url, headers: { origin: "https://foreign.example" } }))
      .statusCode,
    403,
  );
  assert.equal((await app.inject(`${url}&legacy=true`)).statusCode, 400);
  assert.equal(
    (await app.inject("/api/worktrees/changes?path=/not-registered"))
      .statusCode,
    404,
  );
});

test("output limits fail explicitly and FIFO content never blocks a read", async (t) => {
  const { root, reader } = await fixture(t);
  await assert.rejects(
    gitRead(root, ["status", "--porcelain=v2", "--branch"], 1),
    (error: unknown) =>
      error instanceof GitReadError && error.statusCode === 413,
  );
  await exec("mkfifo", [join(root, "pipe")]);
  const started = Date.now();
  // Git does not normally list special files; an unlisted FIFO cannot be queried.
  await assert.rejects(reader.diff(root, "pipe", "untracked"));
  assert(Date.now() - started < 3000);
});

test("rename old paths beginning with a header prefix survive branch header parsing", async (t) => {
  const { root, git, reader } = await fixture(t);
  await writeFile(join(root, "# old name.txt"), "header-like name\n");
  await git("add", "-A");
  await git("commit", "-qm", "name");
  await rename(join(root, "# old name.txt"), join(root, "new name.txt"));
  await git("add", "-A");
  const entry = (await reader.list(root)).entries.find(
    (row) => row.path === "new name.txt",
  );
  assert.equal(entry?.oldPath, "# old name.txt");
  assert.match(
    (await reader.diff(root, "new name.txt", "staged")).diff,
    /header-like name/,
  );
});
