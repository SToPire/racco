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
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Fastify from "fastify";
import { GitHistoryReader, parseCommitBatch } from "./history.js";
import { GitChangesReader } from "./changes.js";
import { GitReadCoordinator, gitReadSignal } from "./coordinator.js";
import { gitRead, GitReadError } from "./git.js";
import { gitChangeRoutes } from "./routes.js";
import {
  GitHistoryPageSchema,
  GitCommitDetailSchema,
  GitCommitDiffSchema,
} from "../../shared/git-history.js";

const exec = promisify(execFile);
async function fixture(t: test.TestContext, commits = 1) {
  const root = await mkdtemp(join(tmpdir(), "racco-history-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    exec("git", args, { cwd: root, encoding: "utf8" });
  await git("init", "-q", "-b", "main");
  await git("config", "user.name", "History Test");
  await git("config", "user.email", "history@example.invalid");
  for (let index = 0; index < commits; index++) {
    await writeFile(join(root, "file.txt"), `${index}\n`);
    await git("add", ".");
    await git("commit", "-qm", `commit ${index}`);
  }
  return { root, git, reader: new GitHistoryReader() };
}
const errorCode = (code: string) => (error: unknown) =>
  error instanceof GitReadError && error.code === code;

test("15-row snapshot pagination pins commit order and reference labels across history rewrites", async (t) => {
  const { root, git, reader } = await fixture(t, 32);
  await git("tag", "-a", "release", "-m", "release", "HEAD~1");
  const expected = (await git("rev-list", "--topo-order", "HEAD")).stdout
    .trim()
    .split("\n");
  const first = GitHistoryPageSchema.parse(await reader.list(root, "current"));
  assert.equal(first.commits.length, 15);
  assert(
    first.commits[1].refs.some(
      (ref) => ref.name === "release" && ref.kind === "tag",
    ),
  );
  await git("reset", "--hard", "HEAD~5");
  await git("tag", "-f", "release", "HEAD");
  const second = await reader.list(root, "current", first.nextCursor!);
  const third = await reader.list(root, "current", second.nextCursor!);
  assert.deepEqual(
    [...first.commits, ...second.commits, ...third.commits].map(
      (item) => item.oid,
    ),
    expected,
  );
  assert.equal(third.nextCursor, null);
  assert.deepEqual(
    await reader.list(root, "current", first.nextCursor!),
    second,
  );
  assert.equal(
    (
      await reader.detail(root, first.snapshotId, first.commits[1].oid)
    ).commit.refs.find((ref) => ref.kind === "tag")?.name,
    "release",
  );
  await assert.rejects(reader.list(root, "all", first.nextCursor!), /不匹配/);
  await assert.rejects(reader.detail(root, first.snapshotId, "HEAD"), /无效/);
  await assert.rejects(
    reader.detail(root, first.snapshotId, "0".repeat(40)),
    /尚未/,
  );
});

test("current includes merged ancestry; all includes branches and remotes but excludes tag-only and stash commits", async (t) => {
  const { root, git, reader } = await fixture(t);
  await git("checkout", "-qb", "side");
  await writeFile(join(root, "side.txt"), "side\n");
  await git("add", ".");
  await git("commit", "-qm", "side");
  const side = (await git("rev-parse", "HEAD")).stdout.trim();
  await git("checkout", "-q", "main");
  await writeFile(join(root, "main.txt"), "main\n");
  await git("add", ".");
  await git("commit", "-qm", "main");
  await git("merge", "--no-ff", "-qm", "merge", "side");
  const first = await reader.list(root, "current");
  assert(first.commits.some((item) => item.oid === side));
  const merge = first.commits[0];
  assert.equal(merge.parents.length, 2);
  const base1 = await reader.detail(root, first.snapshotId, merge.oid);
  const base2 = await reader.detail(
    root,
    first.snapshotId,
    merge.oid,
    merge.parents[1],
  );
  assert.deepEqual(
    base1.files.map((file) => file.path),
    ["side.txt"],
  );
  assert.deepEqual(
    base2.files.map((file) => file.path),
    ["main.txt"],
  );
  await assert.rejects(
    reader.detail(root, first.snapshotId, merge.oid, "root"),
    /实际父/,
  );
  await git("checkout", "-qb", "other", "HEAD~1");
  await git("commit", "--allow-empty", "-qm", "remote only");
  const remote = (await git("rev-parse", "HEAD")).stdout.trim();
  await git("update-ref", "refs/remotes/origin/other", remote);
  await git("commit", "--allow-empty", "-qm", "tag only");
  const tagOnly = (await git("rev-parse", "HEAD")).stdout.trim();
  await git("tag", "tag-only", tagOnly);
  await git("checkout", "-q", "main");
  await git("branch", "-D", "other");
  const all = await reader.list(root, "all");
  assert(all.commits.some((item) => item.oid === remote));
  assert(!all.commits.some((item) => item.oid === tagOnly));
  await git("checkout", "--detach", "-q", tagOnly);
  assert(
    (await reader.list(root, "all")).commits.some(
      (item) => item.oid === tagOnly,
    ),
  );
});

test("root, empty, rename, binary, symlink, executable and submodule changes retain tree semantics", async (t) => {
  const { root, git, reader } = await fixture(t);
  let page = await reader.list(root, "current");
  const original = page.commits[0];
  const detail = GitCommitDetailSchema.parse(
    await reader.detail(root, page.snapshotId, original.oid),
  );
  assert.equal(detail.baseOid, null);
  assert.equal(detail.files[0].status, "A");
  assert.match(
    (await reader.diff(root, page.snapshotId, original.oid, "root", "file.txt"))
      .diff,
    /\+0/,
  );
  await git("commit", "--allow-empty", "-qm", "empty");
  page = await reader.list(root, "current");
  assert.deepEqual(
    (await reader.detail(root, page.snapshotId, page.commits[0].oid)).files,
    [],
  );
  const renamed = ":(glob)renamed\nfile.txt";
  await rename(join(root, "file.txt"), join(root, renamed));
  await writeFile(join(root, "binary"), Buffer.from([0, 1, 2]));
  await writeFile(join(root, "empty"), "");
  await writeFile(join(root, "executable"), "exec\n", { mode: 0o755 });
  const secret = `${root}-secret`;
  await writeFile(secret, "do not read this\n");
  t.after(() => rm(secret, { force: true }));
  await symlink(secret, join(root, "link"));
  await git("add", "-A");
  await git(
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${original.oid},module`,
  );
  await git("commit", "-qm", "special files");
  page = await reader.list(root, "current");
  const commit = page.commits[0];
  const parent = commit.parents[0];
  const files = (await reader.detail(root, page.snapshotId, commit.oid)).files;
  assert.equal(
    files.find((file) => file.path === renamed)?.oldPath,
    "file.txt",
  );
  assert.equal(
    files.find((file) => file.path === "executable")?.newMode,
    "100755",
  );
  const patch = GitCommitDiffSchema.parse(
    await reader.diff(root, page.snapshotId, commit.oid, parent, renamed),
  );
  assert.equal(patch.kind, "metadata");
  assert.match(patch.diff, /rename from file.txt/);
  assert.equal(
    (await reader.diff(root, page.snapshotId, commit.oid, parent, "binary"))
      .kind,
    "binary",
  );
  assert.equal(
    (await reader.diff(root, page.snapshotId, commit.oid, parent, "empty"))
      .kind,
    "metadata",
  );
  assert.equal(
    (await reader.diff(root, page.snapshotId, commit.oid, parent, "module"))
      .kind,
    "submodule",
  );
  const link = await reader.diff(
    root,
    page.snapshotId,
    commit.oid,
    parent,
    "link",
  );
  assert.match(link.diff, /120000/);
  assert(!link.diff.includes("do not read this"));
  await assert.rejects(
    reader.diff(root, page.snapshotId, commit.oid, parent, "../secret"),
    /路径/,
  );
  await assert.rejects(
    reader.diff(root, page.snapshotId, commit.oid, parent, "not-in-commit"),
    /不属于/,
  );
  await writeFile(join(root, renamed), "working tree changed\n");
  assert.deepEqual(
    await reader.diff(root, page.snapshotId, commit.oid, parent, renamed),
    patch,
  );
});

test("shallow raw parents are not mistaken for roots and changed boundary expires snapshot", async (t) => {
  const source = await fixture(t, 4);
  const clone = `${source.root}-shallow`;
  t.after(() => rm(clone, { recursive: true, force: true }));
  await exec("git", [
    "clone",
    "-q",
    "--depth=1",
    `file://${source.root}`,
    clone,
  ]);
  const reader = new GitHistoryReader();
  const page = await reader.list(clone, "current");
  assert(page.shallow);
  assert.equal(page.commits.length, 1);
  assert.equal(page.commits[0].parents.length, 1);
  assert.deepEqual(page.commits[0].boundaryParents, page.commits[0].parents);
  const detail = await reader.detail(
    clone,
    page.snapshotId,
    page.commits[0].oid,
  );
  assert(detail.unavailableReason);
  assert.equal(detail.baseOid, page.commits[0].parents[0]);
  await assert.rejects(
    reader.detail(clone, page.snapshotId, page.commits[0].oid, "root"),
    /实际父/,
  );
  await exec("git", ["fetch", "-q", "--deepen=1"], { cwd: clone });
  await assert.rejects(
    reader.detail(clone, page.snapshotId, page.commits[0].oid),
    errorCode("HISTORY_EXPIRED"),
  );
});

test("snapshot expiry, eviction, byte limits and worktree identity fail explicitly", async (t) => {
  const { root, git } = await fixture(t);
  let now = 0;
  const reader = new GitHistoryReader({
    now: () => now,
    idleMs: 10,
    maxSnapshots: 1,
  });
  const first = await reader.list(root, "current");
  now = 11;
  await assert.rejects(
    reader.detail(root, first.snapshotId, first.commits[0].oid),
    errorCode("HISTORY_EXPIRED"),
  );
  const second = await reader.list(root, "current");
  await reader.list(root, "all");
  await assert.rejects(
    reader.detail(root, second.snapshotId, second.commits[0].oid),
    errorCode("HISTORY_EXPIRED"),
  );
  await assert.rejects(
    new GitHistoryReader({ maxBytes: 1 }).list(root, "current"),
    errorCode("HISTORY_LIMIT"),
  );
  const page = await reader.list(root, "current");
  const worktree = `${root}-worktree`;
  t.after(() => rm(worktree, { recursive: true, force: true }));
  await git("worktree", "add", "--detach", worktree);
  await assert.rejects(
    reader.detail(worktree, page.snapshotId, page.commits[0].oid),
    /不属于所选 Worktree/,
  );
  await mkdir(join(root, "nested"));
  await assert.rejects(reader.list(join(root, "nested"), "current"), /根目录/);
});

test("external diff, textconv and replacement commits are not consulted", async (t) => {
  const { root, git, reader } = await fixture(t);
  const original = (await git("rev-parse", "HEAD")).stdout.trim();
  const script = join(root, "external.sh");
  const marker = join(root, "executed");
  await writeFile(script, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
  await git("config", "diff.external", script);
  await git("config", "diff.spy.textconv", script);
  await writeFile(join(root, ".gitattributes"), "*.txt diff=spy\n");
  await writeFile(join(root, "file.txt"), "new\n");
  await git("add", "file.txt", ".gitattributes");
  await git("commit", "-qm", "real commit");
  const current = (await git("rev-parse", "HEAD")).stdout.trim();
  await git("replace", current, original);
  const page = await reader.list(root, "current");
  assert.equal(page.commits[0].subject, "real commit");
  assert.match(
    (await reader.diff(root, page.snapshotId, current, original, "file.txt"))
      .diff,
    /\+new/,
  );
  await assert.rejects(access(marker));
});

test("metadata framing preserves embedded NUL and isolates malformed display text", () => {
  const oid = "a".repeat(40);
  const raw = Buffer.from(
    `tree ${"b".repeat(40)}\nauthor Test <a@b> 1 +0000\ncommitter Test <a@b> 2 +0000\n\nsubject\nbody\0fake record\n`,
  );
  const framed = Buffer.concat([
    Buffer.from(`${oid} commit ${raw.length}\n`),
    raw,
    Buffer.from("\n"),
  ]);
  assert.equal(
    parseCommitBatch(framed, [oid]).get(oid)?.message,
    "subject\nbody\0fake record\n",
  );
  raw[raw.length - 2] = 255;
  const unreadable = parseCommitBatch(
    Buffer.concat([
      Buffer.from(`${oid} commit ${raw.length}\n`),
      raw,
      Buffer.from("\n"),
    ]),
    [oid],
  ).get(oid)!;
  assert.match(unreadable.textUnavailableReason!, /UTF-8/);
  assert.equal(unreadable.message, "");
  assert.equal(unreadable.subject, "提交说明不可显示");
  assert.equal(unreadable.author.name, "Test");
});

test("cancelled coalesced consumers do not cancel another consumer, and the gate stays held until task exit", async (t) => {
  const { root } = await fixture(t);
  const coordinator = new GitReadCoordinator();
  const first = new AbortController();
  const second = new AbortController();
  let finish!: () => void;
  let underlying!: AbortSignal;
  const started = new Promise<void>((resolve) => {
    const operation = async () => {
      underlying = gitReadSignal.getStore()!;
      resolve();
      await new Promise<void>((done) => {
        finish = done;
      });
      return 7;
    };
    const a = coordinator.run(root, "list", operation, first.signal);
    const b = coordinator.run(root, "list", operation, second.signal);
    t.after(() => finish());
    void a.catch(() => {});
    void b.catch(() => {});
    Object.assign(first, { task: a });
    Object.assign(second, { task: b });
  });
  await started;
  // Let the second realpath finish before cancelling the shared consumers.
  await new Promise((resolve) => setTimeout(resolve, 10));
  first.abort();
  assert.equal(underlying.aborted, false);
  second.abort();
  assert.equal(underlying.aborted, true);
  await assert.rejects(
    coordinator.run(root, "other", async () => 0),
    errorCode("GIT_BUSY"),
  );
  finish();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(await coordinator.run(root, "other", async () => 9), 9);
});

test("history and current state share the canonical gate, and subprocess cancellation reaches exit", async (t) => {
  const { root, reader } = await fixture(t, 20);
  const changes = new GitChangesReader();
  const list = reader.list(root, "current");
  await assert.rejects(changes.list(root), errorCode("GIT_BUSY"));
  await list;
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "git"),
    `#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n`,
    { mode: 0o755 },
  );
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous}`;
  try {
    const controller = new AbortController();
    const task = gitRead(root, ["ignored"], 100, { signal: controller.signal });
    const start = Date.now();
    setTimeout(() => controller.abort(), 25);
    await assert.rejects(task, errorCode("GIT_ABORTED"));
    assert(Date.now() - start < 1000);
  } finally {
    process.env.PATH = previous;
  }
});

test("history routes enforce registration, origins, revision and schema boundaries", async (t) => {
  const { root } = await fixture(t);
  const app = Fastify();
  t.after(() => app.close());
  await app.register(gitChangeRoutes, {
    worktreeIsAvailable: async (path) => path === root,
  });
  const query = new URLSearchParams({ path: root, scope: "current" });
  const url = `/api/worktrees/commits?${query}`;
  const response = await app.inject(url);
  assert.equal(response.statusCode, 200);
  const page = GitHistoryPageSchema.parse(response.json());
  const detail = `/api/worktrees/commit?${new URLSearchParams({ path: root, snapshotId: page.snapshotId, oid: page.commits[0].oid })}`;
  assert.equal((await app.inject(detail)).statusCode, 200);
  assert.equal((await app.inject(`${detail}&parent=HEAD~1`)).statusCode, 400);
  assert.equal((await app.inject(`${url}&extra=x`)).statusCode, 400);
  assert.equal(
    (await app.inject("/api/worktrees/commits?path=/missing&scope=current"))
      .statusCode,
    404,
  );
  assert.equal(
    (await app.inject({ url, headers: { origin: "https://foreign.example" } }))
      .statusCode,
    403,
  );
  const expiredResponse = await app.inject(
    `/api/worktrees/commits?${query}&cursor=expired.cursor`,
  );
  assert.equal(expiredResponse.statusCode, 410);
  assert.equal(expiredResponse.json().code, "HISTORY_EXPIRED");
});

test("unborn worktrees return explicit empty history and coalesced alias lists keep their request paths", async (t) => {
  const { root, reader } = await fixture(t, 0);
  const empty = await reader.list(root, "current");
  assert.equal(empty.head, null);
  assert.equal(empty.branch, "main");
  assert.deepEqual(empty.commits, []);
  assert.equal(empty.nextCursor, null);
  const alias = `${root}-alias`;
  await symlink(root, alias);
  t.after(() => rm(alias, { force: true }));
  const [a, b] = await Promise.all([
    reader.list(root, "all"),
    reader.list(alias, "all"),
  ]);
  assert.equal(a.snapshotId, b.snapshotId);
  assert.equal(a.path, root);
  assert.equal(b.path, alias);
  const changes = new GitChangesReader();
  const [c, d] = await Promise.all([changes.list(root), changes.list(alias)]);
  assert.equal(c.path, root);
  assert.equal(d.path, alias);
});

test("oversized blobs and excessive diff lines return unavailable without truncating patches", async (t) => {
  const { root, git, reader } = await fixture(t);
  await writeFile(join(root, "large"), Buffer.alloc(2 * 1024 * 1024 + 1, 65));
  await writeFile(join(root, "many-lines"), "x\n".repeat(20_001));
  await git("add", ".");
  await git("commit", "-qm", "large content");
  const page = await reader.list(root, "current");
  const commit = page.commits[0];
  for (const file of ["large", "many-lines"]) {
    const result = await reader.diff(
      root,
      page.snapshotId,
      commit.oid,
      commit.parents[0],
      file,
    );
    assert.equal(result.kind, "unavailable");
    assert.equal(result.diff, "");
    assert(result.reason);
  }
});

test("rename patches preserve quoted control characters and Unicode paths", async (t) => {
  const { root, git, reader } = await fixture(t);
  const target = 'new\t"名字".txt';
  await rename(join(root, "file.txt"), join(root, target));

  await git("add", "-A");
  await git("commit", "-qm", "rename and recreate");
  const page = await reader.list(root, "current");
  const commit = page.commits[0];
  const detail = await reader.detail(root, page.snapshotId, commit.oid);
  assert.equal(
    detail.files.find((file) => file.path === target)?.oldPath,
    "file.txt",
  );
  const patch = await reader.diff(
    root,
    page.snapshotId,
    commit.oid,
    commit.parents[0],
    target,
  );
  assert.equal(patch.kind, "metadata");
  assert.match(patch.diff, /rename from file.txt/);
  assert(patch.diff.includes("名字"));
});

test("non-UTF8 commit text keeps topology, pagination and historical tree diffs readable", async (t) => {
  const { root, git, reader } = await fixture(t);
  const tree = (await git("rev-parse", "HEAD^{tree}")).stdout.trim();
  let parent = (await git("rev-parse", "HEAD")).stdout.trim();
  const created: string[] = [];
  const invalidAuthor = 1;
  const invalidMessage = 15;
  const declaredLatin = 17;
  const input = join(root, ".git", "commit-input");
  for (let index = 0; index < 18; index++) {
    const author =
      index === invalidAuthor
        ? Buffer.concat([
            Buffer.from("Andr"),
            Buffer.from([0xe9]),
            Buffer.from(" <invalid"),
            Buffer.from([0xff]),
            Buffer.from("@example.invalid>"),
          ])
        : Buffer.from("作者 <author@example.invalid>");
    const body =
      index === declaredLatin
        ? Buffer.from("caf\xe9\n", "latin1")
        : index === invalidMessage
          ? Buffer.from([0xff, 10])
          : Buffer.from(`提交 ${index}\nbody\0preserved\n`);
    const raw = Buffer.concat([
      Buffer.from(`tree ${tree}\nparent ${parent}\nauthor `),
      author,
      Buffer.from(
        ` ${index + 2} +0000\ncommitter 提交者 <committer@example.invalid> ${index + 2} +0000\n`,
      ),
      ...(index === declaredLatin
        ? [Buffer.from("encoding ISO-8859-1\n")]
        : []),
      Buffer.from("\n"),
      body,
    ]);
    await writeFile(input, raw);
    parent = (
      await git("hash-object", "--literally", "-t", "commit", "-w", input)
    ).stdout.trim();
    created.push(parent);
  }
  await git("update-ref", "refs/heads/main", parent);
  const first = GitHistoryPageSchema.parse(await reader.list(root, "current"));
  const second = GitHistoryPageSchema.parse(
    await reader.list(root, "current", first.nextCursor!),
  );
  assert.equal(first.commits.length, 15);
  assert.equal(second.nextCursor, null);
  const commits = [...first.commits, ...second.commits];
  assert.equal(commits.length, 19);
  assert.deepEqual(
    commits.slice(0, 18).map((commit) => commit.oid),
    created.toReversed(),
  );
  const latin = commits.find(
    (commit) => commit.oid === created[declaredLatin],
  )!;
  assert.match(latin.textUnavailableReason!, /ISO-8859-1/);
  assert.equal(latin.subject, "提交说明不可显示");
  assert.equal(latin.author.name, "作者不可显示");
  assert.equal(latin.parents[0], created[declaredLatin - 1]);
  assert.equal(
    latin.authoredAt,
    new Date((declaredLatin + 2) * 1000).toISOString(),
  );
  const unreadableMessage = commits.find(
    (commit) => commit.oid === created[invalidMessage],
  )!;
  assert.match(unreadableMessage.textUnavailableReason!, /UTF-8/);
  assert.equal(unreadableMessage.author.name, "作者");
  const unreadableAuthor = commits.find(
    (commit) => commit.oid === created[invalidAuthor],
  )!;
  assert.match(unreadableAuthor.textUnavailableReason!, /UTF-8/);
  assert.equal(unreadableAuthor.author.name, "作者不可显示");
  assert.equal(unreadableAuthor.author.email, "");
  assert.equal(unreadableAuthor.subject, "提交 1");
  const normal = await reader.detail(root, first.snapshotId, created[0]);
  assert.equal(normal.commit.textUnavailableReason, null);
  assert.equal(normal.commit.message, "提交 0\nbody\0preserved\n");
  const latinDetail = GitCommitDetailSchema.parse(
    await reader.detail(root, first.snapshotId, latin.oid),
  );
  assert.equal(latinDetail.commit.message, "");
  assert.deepEqual(latinDetail.files, []);

  // An unsupported-encoding root still exposes the tree's file list and patch.
  const unreadableRoot = Buffer.concat([
    Buffer.from(
      `tree ${tree}\nauthor Test <a@b> 1 +0000\ncommitter Test <a@b> 1 +0000\nencoding ISO-8859-1\n\n`,
    ),
    Buffer.from([0xe9, 10]),
  ]);
  await writeFile(input, unreadableRoot);
  const rootOid = (
    await git("hash-object", "--literally", "-t", "commit", "-w", input)
  ).stdout.trim();
  await git("update-ref", "refs/heads/main", rootOid);
  const rootPage = await reader.list(root, "current");
  const detail = await reader.detail(root, rootPage.snapshotId, rootOid);
  assert.equal(detail.files[0].path, "file.txt");
  assert.match(
    (await reader.diff(root, rootPage.snapshotId, rootOid, "root", "file.txt"))
      .diff,
    /\+0/,
  );
});

test("commit structure corruption remains fatal when display text is unavailable", () => {
  const oid = "a".repeat(40);
  const base = `tree ${"b".repeat(40)}\nparent ${"c".repeat(40)}\nauthor Test <a@b> 1 +0000\ncommitter Test <a@b> 2 +0000\nencoding ISO-8859-1\n\n`;
  const frame = (header: string) => {
    const raw = Buffer.concat([Buffer.from(header), Buffer.from([0xff])]);
    return Buffer.concat([
      Buffer.from(`${oid} commit ${raw.length}\n`),
      raw,
      Buffer.from("\n"),
    ]);
  };
  for (const malformed of [
    base.replace(`tree ${"b".repeat(40)}\n`, ""),
    base.replace(`parent ${"c".repeat(40)}`, "parent not-an-oid"),
    base.replace("author Test <a@b> 1 +0000", "author Test <a@b> nope +0000"),
    base.replace(
      "committer Test <a@b> 2 +0000",
      "committer Test <a@b> 2 +0000\ncommitter Test <a@b> 3 +0000",
    ),
    base.replace("encoding ISO-8859-1", "encoding ISO-8859-1\nencoding utf-8"),
  ]) {
    assert.throws(
      () => parseCommitBatch(frame(malformed), [oid]),
      GitReadError,
    );
  }
  const valid = frame(base);
  assert.throws(
    () => parseCommitBatch(valid.subarray(0, valid.length - 1), [oid]),
    /长度/,
  );
});
