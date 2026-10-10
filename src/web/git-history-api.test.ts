import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GitPatchCache,
  jsonBytes,
  listGitHistory,
  readGitCommitDiff,
} from "./git-history-api";
import { GitApiError } from "./git-request";

test("patch cache evicts the least recently used patch and accounts for UTF-8 bytes", () => {
  const size = jsonBytes("你好");
  assert.equal(size, 8);
  const cache = new GitPatchCache<string>(size * 2);
  cache.set("a", "你好");
  cache.set("b", "你好");
  assert.equal(cache.get("a"), "你好");
  cache.set("c", "你好");
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("a"), "你好");
  assert.equal(cache.get("c"), "你好");
  cache.set("big", "你好你好你好");
  assert.equal(cache.get("big"), undefined);
  cache.clear();
  assert.equal(cache.get("a"), undefined);
});

test("history responses must match Worktree and selected scope", async (context) => {
  context.mock.method(globalThis, "fetch", async () =>
    Response.json({
      path: "/other",
      scope: "current",
      snapshotId: "snapshot",
      head: null,
      branch: null,
      readAt: new Date().toISOString(),
      commits: [],
      nextCursor: null,
      shallow: false,
    }),
  );
  await assert.rejects(
    listGitHistory("/requested", "current", new AbortController().signal),
    /当前范围不符/,
  );
});

test("patch requests explicitly select the empty tree for a root commit and validate the returned baseline", async (context) => {
  const oid = "a".repeat(40);
  context.mock.method(globalThis, "fetch", async (url: string) => {
    assert.equal(
      new URL(url, "http://localhost").searchParams.get("parent"),
      "root",
    );
    return Response.json({
      path: "/root",
      snapshotId: "snapshot",
      oid,
      baseOid: "b".repeat(40),
      file: "file",
      oldPath: null,
      kind: "text",
      diff: "",
      reason: null,
    });
  });
  await assert.rejects(
    readGitCommitDiff(
      "/root",
      "snapshot",
      oid,
      "root",
      "file",
      new AbortController().signal,
    ),
    /选中条目不符/,
  );
});

test("Git API preserves busy and expired codes for explicit UI recovery", async (context) => {
  context.mock.method(globalThis, "fetch", async () =>
    Response.json(
      { message: "历史快照失效", code: "HISTORY_EXPIRED" },
      { status: 410 },
    ),
  );
  await assert.rejects(
    listGitHistory("/expired", "current", new AbortController().signal),
    (failure) =>
      failure instanceof GitApiError &&
      failure.status === 410 &&
      failure.code === "HISTORY_EXPIRED",
  );
});

test("unavailable commit display text preserves topology and an explicit reason", async (context) => {
  const oid = "a".repeat(40);
  const parent = "b".repeat(40);
  const commit = {
    oid,
    parents: [parent],
    boundaryParents: [],
    subject: "",
    textUnavailableReason: "提交说明采用不支持的编码，无法显示。",
    author: { name: "", email: "" },
    authoredAt: "2026-10-09T00:00:00.000Z",
    committedAt: "2026-10-09T00:00:00.000Z",
    refs: [],
  };
  context.mock.method(globalThis, "fetch", async () =>
    Response.json({
      path: "/unavailable-text",
      scope: "current",
      snapshotId: "snapshot",
      head: oid,
      branch: "main",
      readAt: "2026-10-09T00:00:00.000Z",
      commits: [commit],
      nextCursor: null,
      shallow: false,
    }),
  );
  const page = await listGitHistory(
    "/unavailable-text",
    "current",
    new AbortController().signal,
  );
  assert.deepEqual(page.commits[0].parents, [parent]);
  assert.equal(
    page.commits[0].textUnavailableReason,
    commit.textUnavailableReason,
  );
  assert.equal(page.commits[0].subject, "");
});
