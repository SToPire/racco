import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import {
  GIT_HISTORY_BATCH_SIZE,
  GIT_HISTORY_MAX_BYTES,
  GIT_HISTORY_MAX_COMMITS,
  GitObjectIdSchema,
  type GitCommitDetail,
  type GitCommitDiff,
  type GitCommitFile,
  type GitCommitSummary,
  type GitHistoryPage,
  type GitHistoryScope,
} from "../../shared/git-history.js";
import { validateGitPath } from "./changes.js";
import { gitReads } from "./coordinator.js";
import { gitRead, GitReadError, strictText, gitRoot } from "./git.js";

const MAX_TEXT = 2 * 1024 * 1024;
const MAX_FILES = 1000;
type Commit = GitCommitDetail["commit"];
type GitCommitRef = GitCommitSummary["refs"][number];
type Ref = {
  name: string;
  oid: string;
  peeled: string;
  type: string;
  peeledType: string;
};
type Identity = {
  refsText: string;
  refs: Ref[];
  head: string | null;
  branch: string | null;
  shallow: string;
};
type Snapshot = {
  id: string;
  root: string;
  scope: GitHistoryScope;
  identity: Identity;
  tips: string[];
  refs: Map<string, GitCommitRef[]>;
  shallow: Set<string>;
  readAt: string;
  touchedAt: number;
  commits: Map<string, Commit>;
  pages: Map<number, GitHistoryPage>;
  cursors: Map<string, number>;
  bytes: number;
};

function expired(): GitReadError {
  return new GitReadError(
    "提交历史快照已失效，请显式刷新历史。",
    410,
    "HISTORY_EXPIRED",
  );
}
function limit(
  message = "提交历史超过容量上限，请缩小历史范围。",
): GitReadError {
  return new GitReadError(message, 413, "HISTORY_LIMIT");
}
function validOid(oid: string): void {
  if (!GitObjectIdSchema.safeParse(oid).success)
    throw new GitReadError("提交对象 ID 无效。", 400);
}
function summary({
  message: _message,
  committer: _committer,
  ...commit
}: Commit): GitCommitSummary {
  return commit;
}
async function shallowIdentity(root: string): Promise<string> {
  const path = strictText(
    await gitRead(root, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "shallow",
    ]),
  ).replace(/\n$/, "");
  try {
    // This is repository metadata, never a revision or client-controlled path.
    const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    let file: Buffer;
    try {
      if (!(await handle.stat()).isFile())
        throw new GitReadError("浅克隆边界不是普通文件。", 422);
      const buffer = Buffer.alloc(512 * 1024 + 1);
      let size = 0;
      while (size < buffer.length) {
        const read = await handle.read(
          buffer,
          size,
          buffer.length - size,
          size,
        );
        if (!read.bytesRead) break;
        size += read.bytesRead;
      }
      file = buffer.subarray(0, size);
    } finally {
      await handle.close();
    }
    if (file.length > 512 * 1024) throw limit("浅克隆边界超过容量上限。");
    const text = strictText(file);
    for (const oid of text.trim().split("\n").filter(Boolean)) validOid(oid);
    return text;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}
async function identity(root: string): Promise<Identity> {
  const refsText = strictText(
    await gitRead(root, [
      "for-each-ref",
      "--format=%(refname)%00%(objectname)%00%(*objectname)%00%(objecttype)%00%(*objecttype)",
      "refs/heads/",
      "refs/remotes/",
      "refs/tags/",
    ]),
  );
  const rows = refsText.split("\n").filter(Boolean);
  if (rows.length > 4096) throw limit("引用数量超过 4096 项。");
  const refs = rows.map((row) => {
    const [name, oid, peeled, type, peeledType, ...extra] = row.split("\0");
    if (!name || !oid || extra.length || peeledType === undefined)
      throw new GitReadError("Git 引用格式无效。", 422);
    validOid(oid);
    if (peeled) validOid(peeled);
    return { name, oid, peeled, type, peeledType };
  });
  let branch: string | null = null;
  try {
    branch = strictText(
      await gitRead(root, ["symbolic-ref", "-q", "HEAD"]),
    ).trim();
  } catch (error) {
    if (!(error instanceof GitReadError) || error.statusCode !== 422)
      throw error;
  }
  let head: string | null = null;
  try {
    head = strictText(
      await gitRead(root, ["rev-parse", "--verify", "--quiet", "HEAD"]),
    ).trim();
    validOid(head);
  } catch (error) {
    if (
      !(error instanceof GitReadError) ||
      error.statusCode !== 422 ||
      !branch ||
      refs.some((ref) => ref.name === branch)
    )
      throw error;
  }
  return {
    refsText,
    refs,
    head,
    branch: branch?.replace(/^refs\/heads\//, "") ?? null,
    shallow: await shallowIdentity(root),
  };
}
function sameIdentity(a: Identity, b: Identity): boolean {
  return (
    a.refsText === b.refsText &&
    a.head === b.head &&
    a.branch === b.branch &&
    a.shallow === b.shallow
  );
}
function person(line: string): {
  person: { name: string; email: string };
  at: string;
} {
  const match = /^(.*) <([^<>]*)> (-?\d+) ([+-]\d{4})$/.exec(line);
  if (!match) throw new GitReadError("Git 提交作者格式无效。", 422);
  const date = new Date(Number(match[3]) * 1000);
  if (!Number.isFinite(date.getTime()))
    throw new GitReadError("Git 提交时间无效。", 422);
  return {
    person: { name: match[1], email: match[2] },
    at: date.toISOString(),
  };
}

/** Batch records use byte lengths, so commit messages may contain newlines and NULs. */
export function parseCommitBatch(
  bytes: Buffer,
  expected: string[],
): Map<string, Commit> {
  let offset = 0;
  const commits = new Map<string, Commit>();
  for (const oid of expected) {
    const newline = bytes.indexOf(10, offset);
    if (newline < 0) throw new GitReadError("Git 对象记录不完整。", 422);
    const header = strictText(bytes.subarray(offset, newline));
    const match = /^([0-9a-f]+) commit (\d+)$/.exec(header);
    if (!match || match[1] !== oid) throw expired();
    const size = Number(match[2]);
    offset = newline + 1;
    if (
      !Number.isSafeInteger(size) ||
      size > GIT_HISTORY_MAX_BYTES ||
      offset + size >= bytes.length ||
      bytes[offset + size] !== 10
    )
      throw new GitReadError("Git 对象长度无效。", 422);
    const object = bytes.subarray(offset, offset + size);
    offset += size + 1;
    const split = object.indexOf("\n\n");
    if (split < 0) throw new GitReadError("Git 提交对象格式无效。", 422);
    // Latin-1 only carries header bytes through ASCII structural delimiters.
    // Keep the body as bytes: a short sliced field must not retain discarded text.
    const headers = object.subarray(0, split).toString("latin1").split("\n");
    const uniqueHeader = (
      name: string,
      required = true,
    ): string | undefined => {
      const rows = headers.filter((line) => line.startsWith(`${name} `));
      if (rows.length > 1 || (required && rows.length !== 1))
        throw new GitReadError("Git 提交结构字段无效。", 422);
      return rows[0]?.slice(name.length + 1);
    };
    for (const line of headers) {
      if (!line.startsWith(" ") && !/^[a-z][a-z0-9-]* /.test(line))
        throw new GitReadError("Git 提交头部格式无效。", 422);
    }
    validOid(uniqueHeader("tree")!);
    const rawEncoding = uniqueHeader("encoding", false);
    if (rawEncoding !== undefined && !/^[A-Za-z0-9._-]+$/.test(rawEncoding))
      throw new GitReadError("Git 提交编码声明格式无效。", 422);
    // Copy retained structure fields away from the complete header backing string.
    const encoding =
      rawEncoding === undefined
        ? undefined
        : strictText(Buffer.from(rawEncoding, "latin1"));
    const supportedEncoding =
      !encoding || /^(utf-8|utf8|us-ascii)$/i.test(encoding);
    let textUnavailableReason: string | null = supportedEncoding
      ? null
      : `提交元数据声明了不支持的编码 ${encoding}；文本不可显示。`;
    const displayText = (raw: string | Buffer, unavailable = ""): string => {
      if (!supportedEncoding) return unavailable;
      try {
        return strictText(
          typeof raw === "string" ? Buffer.from(raw, "latin1") : raw,
        );
      } catch (error) {
        if (!(error instanceof GitReadError)) throw error;
        textUnavailableReason =
          "提交元数据包含非 UTF-8 文本；不可解码的字段已隐藏。";
        return unavailable;
      }
    };
    const parents = headers
      .filter((line) => line.startsWith("parent "))
      .map((line) => {
        const parent = line.slice(7);
        validOid(parent);
        return strictText(Buffer.from(parent, "latin1"));
      });
    const rawAuthor = person(uniqueHeader("author")!);
    const rawCommitter = person(uniqueHeader("committer")!);
    const author = {
      name: displayText(rawAuthor.person.name, "作者不可显示"),
      email: displayText(rawAuthor.person.email),
    };
    const committer = {
      name: displayText(rawCommitter.person.name, "提交者不可显示"),
      email: displayText(rawCommitter.person.email),
    };
    const rawMessage = object.subarray(split + 2);
    const message = displayText(rawMessage);
    const subject =
      rawMessage.length && !message
        ? "提交说明不可显示"
        : message.split("\n")[0];
    commits.set(oid, {
      oid,
      parents,
      boundaryParents: [],
      subject,
      textUnavailableReason,
      author,
      authoredAt: rawAuthor.at,
      committedAt: rawCommitter.at,
      refs: [],
      message,
      committer,
    });
  }
  if (offset !== bytes.length)
    throw new GitReadError("Git 对象记录包含多余数据。", 422);
  return commits;
}

export function parseCommitFiles(bytes: Buffer): GitCommitFile[] {
  const rows = strictText(bytes).split("\0");
  const result: GitCommitFile[] = [];
  let index = 0;
  while (index < rows.length && rows[index]) {
    const match =
      /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([AMDRCT])\d*$/.exec(
        rows[index++],
      );
    if (!match) throw new GitReadError("Git 提交文件格式无效。", 422);
    const first = rows[index++];
    validateGitPath(first ?? "");
    const renamed = match[5] === "R" || match[5] === "C";
    const path = renamed ? rows[index++] : first;
    validateGitPath(path ?? "");
    const oldOid = /^0+$/.test(match[3]) ? null : match[3];
    const newOid = /^0+$/.test(match[4]) ? null : match[4];
    if (oldOid) validOid(oldOid);
    if (newOid) validOid(newOid);
    result.push({
      path,
      oldPath: renamed ? first : null,
      status: match[5] as GitCommitFile["status"],
      oldMode: match[1] === "000000" ? null : match[1],
      newMode: match[2] === "000000" ? null : match[2],
      oldOid,
      newOid,
    });
    if (result.length > MAX_FILES)
      throw limit("提交修改文件超过 1000 项，无法完整展示。");
  }
  if (rows.slice(index).some(Boolean))
    throw new GitReadError("Git 提交文件记录不完整。", 422);
  return result;
}

function quotedPatchPath(path: string): string {
  const escapes: Record<string, string> = {
    "\x07": "\\a",
    "\b": "\\b",
    "\t": "\\t",
    "\n": "\\n",
    "\v": "\\v",
    "\f": "\\f",
    "\r": "\\r",
    '"': '\\"',
    "\\": "\\\\",
  };
  const special = (char: string) =>
    char.charCodeAt(0) < 32 ||
    char.charCodeAt(0) === 127 ||
    char === '"' ||
    char === "\\";
  if (!Array.from(path).some(special)) return path;
  return `"${Array.from(path)
    .map((char) =>
      special(char)
        ? (escapes[char] ??
          `\\${char.charCodeAt(0).toString(8).padStart(3, "0")}`)
        : char,
    )
    .join("")}"`;
}

/** Keep one verified patch even when both rename endpoints are selected. */
function selectedPatch(patch: string, entry: GitCommitFile): string {
  const header = `diff --git ${quotedPatchPath(`a/${entry.oldPath ?? entry.path}`)} ${quotedPatchPath(`b/${entry.path}`)}\n`;
  const matching = patch
    .split(/(?=^diff --git )/m)
    .filter((block) => block.startsWith(header));
  if (matching.length !== 1)
    throw new GitReadError("无法唯一识别所选文件的提交差异。", 422);
  return matching[0];
}

export class GitHistoryReader {
  readonly #snapshots = new Map<string, Snapshot>();
  readonly #readerId = randomUUID();
  readonly #maxSnapshots: number;
  readonly #maxBytes: number;
  readonly #idleMs: number;
  readonly #now: () => number;

  constructor(
    options: {
      maxSnapshots?: number;
      maxBytes?: number;
      idleMs?: number;
      now?: () => number;
    } = {},
  ) {
    this.#maxSnapshots = options.maxSnapshots ?? 32;
    this.#maxBytes = options.maxBytes ?? GIT_HISTORY_MAX_BYTES;
    this.#idleMs = options.idleMs ?? 10 * 60 * 1000;
    this.#now = options.now ?? Date.now;
  }

  list(
    path: string,
    scope: GitHistoryScope,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<GitHistoryPage> {
    return gitReads
      .run(
        path,
        `history:${this.#readerId}:${scope}:${cursor ?? "new"}`,
        async (root) => {
          if (scope !== "current" && scope !== "all")
            throw new GitReadError("历史范围无效。", 400);
          await gitRoot(root);
          if (cursor) {
            const snapshot = this.#get(root, cursor.split(".")[0]);
            if (snapshot.scope !== scope || !snapshot.cursors.has(cursor))
              throw new GitReadError("历史游标与查询不匹配。", 400);
            await this.#validate(snapshot);
            return {
              ...(await this.#page(snapshot, snapshot.cursors.get(cursor)!)),
              path,
            };
          }
          for (let attempt = 0; attempt < 2; attempt++) {
            const before = await identity(root);
            const tips =
              scope === "current"
                ? before.head
                  ? [before.head]
                  : []
                : [
                    ...new Set([
                      ...before.refs
                        .filter(
                          (ref) =>
                            /^(refs\/heads\/|refs\/remotes\/)/.test(ref.name) &&
                            ref.type === "commit",
                        )
                        .map((ref) => ref.oid),
                      ...(before.head ? [before.head] : []),
                    ]),
                  ];
            const refs = new Map<string, GitCommitRef[]>();
            const addRef = (oid: string, label: GitCommitRef) =>
              refs.set(oid, [...(refs.get(oid) ?? []), label]);
            for (const ref of before.refs) {
              let oid =
                ref.type === "commit"
                  ? ref.oid
                  : ref.peeledType === "commit"
                    ? ref.peeled
                    : null;
              if (!oid && ref.type === "tag" && ref.peeledType === "tag") {
                try {
                  oid = strictText(
                    await gitRead(root, [
                      "rev-parse",
                      "--verify",
                      `${ref.oid}^{commit}`,
                    ]),
                  ).trim();
                } catch (error) {
                  if (
                    !(error instanceof GitReadError) ||
                    error.statusCode !== 422
                  )
                    throw error;
                }
              }
              if (!oid) continue;
              const kind = ref.name.startsWith("refs/heads/")
                ? "branch"
                : ref.name.startsWith("refs/remotes/")
                  ? "remote"
                  : "tag";
              addRef(oid, {
                name: ref.name.replace(/^refs\/(heads|remotes|tags)\//, ""),
                kind,
              });
            }
            if (before.head)
              addRef(before.head, { name: "HEAD", kind: "head" });
            const snapshot: Snapshot = {
              id: randomUUID(),
              root,
              scope,
              identity: before,
              tips,
              refs,
              shallow: new Set(
                before.shallow.trim().split("\n").filter(Boolean),
              ),
              readAt: new Date().toISOString(),
              touchedAt: this.#now(),
              commits: new Map(),
              pages: new Map(),
              cursors: new Map(),
              bytes: 0,
            };
            const page = await this.#page(snapshot, 0, false);
            if (!sameIdentity(before, await identity(root))) continue;
            this.#snapshots.set(snapshot.id, snapshot);
            try {
              this.#bound(snapshot);
            } catch (error) {
              this.#snapshots.delete(snapshot.id);
              throw error;
            }
            return { ...page, path };
          }
          throw new GitReadError(
            "Git 引用正在变化，请重试刷新历史。",
            409,
            "HISTORY_CHANGED",
          );
        },
        signal,
      )
      .then((page) => ({ ...page, path }));
  }

  detail(
    path: string,
    snapshotId: string,
    oid: string,
    parent?: string,
    signal?: AbortSignal,
  ): Promise<GitCommitDetail> {
    return gitReads.run(
      path,
      null,
      async (root) => {
        await gitRoot(root);
        const snapshot = this.#get(root, snapshotId);
        await this.#validate(snapshot);
        const result = await this.#detail(snapshot, oid, parent);
        await this.#validate(snapshot);
        return { ...result, path };
      },
      signal,
    );
  }

  diff(
    path: string,
    snapshotId: string,
    oid: string,
    parent: string,
    file: string,
    signal?: AbortSignal,
  ): Promise<GitCommitDiff> {
    return gitReads.run(
      path,
      null,
      async (root) => {
        validateGitPath(file);
        await gitRoot(root);
        const snapshot = this.#get(root, snapshotId);
        await this.#validate(snapshot);
        const detail = await this.#detail(snapshot, oid, parent);
        if (detail.unavailableReason)
          throw new GitReadError(
            detail.unavailableReason,
            422,
            "HISTORY_BASE_UNAVAILABLE",
          );
        const entry = detail.files.find((item) => item.path === file);
        if (!entry) throw new GitReadError("文件不属于本次提交比较。", 404);
        const result: GitCommitDiff = {
          path,
          snapshotId,
          oid,
          baseOid: detail.baseOid,
          file,
          oldPath: entry.oldPath,
          kind: "metadata",
          diff: "",
          reason: null,
        };
        if (entry.oldMode === "160000" || entry.newMode === "160000") {
          result.kind = "submodule";
          result.reason = `子模块对象 ${entry.oldOid ?? "无"} → ${entry.newOid ?? "无"}，不递归读取子模块。`;
        } else {
          try {
            for (const blob of [entry.oldOid, entry.newOid]) {
              if (!blob) continue;
              const size = Number(
                strictText(await gitRead(root, ["cat-file", "-s", blob])),
              );
              if (!Number.isSafeInteger(size) || size > MAX_TEXT)
                throw limit("Git 文件对象超过 2 MiB，无法展示差异。");
            }
            const bytes = await gitRead(
              root,
              [
                `--attr-source=${oid}`,
                "-c",
                "core.attributesFile=/dev/null",
                "-c",
                "core.quotePath=false",
                "diff-tree",
                "--no-commit-id",
                "-r",
                "--root",
                "--patch",
                "--no-ext-diff",
                "--no-textconv",
                "--no-color",
                "--src-prefix=a/",
                "--dst-prefix=b/",
                "--find-renames",
                "--submodule=short",
                ...(detail.baseOid ? [detail.baseOid] : []),
                oid,
                "--",
                ...(entry.oldPath ? [entry.oldPath] : []),
                file,
              ],
              MAX_TEXT,
            );
            result.diff = selectedPatch(strictText(bytes), entry);
            if (result.diff.split("\n").length > 20_000)
              throw limit("差异超过 20000 行。");
            if (/^Binary files .* differ$/m.test(result.diff)) {
              result.kind = "binary";
              result.reason = "二进制文件，无法展示文本差异。";
            } else {
              result.kind = /^@@ /m.test(result.diff) ? "text" : "metadata";
              if (result.kind === "metadata")
                result.reason = "仅元数据或空文件变化。";
            }
          } catch (error) {
            if (
              !(error instanceof GitReadError) ||
              ![413, 422].includes(error.statusCode)
            )
              throw error;
            result.kind = "unavailable";
            result.diff = "";
            result.reason = error.message;
          }
        }
        await this.#validate(snapshot);
        return result;
      },
      signal,
    );
  }

  #get(root: string, id: string): Snapshot {
    this.#prune();
    const snapshot = this.#snapshots.get(id);
    if (!snapshot) throw expired();
    if (snapshot.root !== root)
      throw new GitReadError("历史快照不属于所选 Worktree。", 400);
    snapshot.touchedAt = this.#now();
    return snapshot;
  }
  #prune(): void {
    for (const [id, snapshot] of this.#snapshots)
      if (this.#now() - snapshot.touchedAt >= this.#idleMs)
        this.#snapshots.delete(id);
  }
  #bound(current: Snapshot): void {
    this.#prune();
    const size = Buffer.byteLength(
      JSON.stringify({
        ...current,
        refs: [...current.refs],
        shallow: [...current.shallow],
        commits: [...current.commits],
        pages: [...current.pages],
        cursors: [...current.cursors],
      }),
    );
    if (size > this.#maxBytes) throw limit();
    current.bytes = size;
    const total = () =>
      [...this.#snapshots.values()].reduce((sum, item) => sum + item.bytes, 0);
    for (const old of [...this.#snapshots.values()].sort(
      (a, b) => a.touchedAt - b.touchedAt,
    )) {
      if (
        this.#snapshots.size <= this.#maxSnapshots &&
        total() <= this.#maxBytes
      )
        break;
      if (old !== current) this.#snapshots.delete(old.id);
    }
  }
  async #validate(snapshot: Snapshot): Promise<void> {
    if ((await shallowIdentity(snapshot.root)) !== snapshot.identity.shallow) {
      this.#snapshots.delete(snapshot.id);
      throw expired();
    }
  }
  async #page(
    snapshot: Snapshot,
    offset: number,
    publish = true,
  ): Promise<GitHistoryPage> {
    const cached = snapshot.pages.get(offset);
    if (cached) return cached;
    if (offset >= GIT_HISTORY_MAX_COMMITS)
      throw limit("已达到 5000 条提交浏览上限。");
    const count = Math.min(
      GIT_HISTORY_BATCH_SIZE,
      GIT_HISTORY_MAX_COMMITS - offset,
    );
    const oids = snapshot.tips.length
      ? strictText(
          await gitRead(snapshot.root, [
            "rev-list",
            "--topo-order",
            `--skip=${offset}`,
            `--max-count=${count + 1}`,
            ...snapshot.tips,
            "--",
          ]),
        )
          .trim()
          .split("\n")
          .filter(Boolean)
      : [];
    oids.forEach(validOid);
    const visible = oids.slice(0, count);
    const commits = visible.length
      ? parseCommitBatch(
          await gitRead(
            snapshot.root,
            ["cat-file", "--batch"],
            GIT_HISTORY_MAX_BYTES,
            { input: `${visible.join("\n")}\n` },
          ),
          visible,
        )
      : new Map<string, Commit>();
    for (const commit of commits.values()) {
      commit.refs = snapshot.refs.get(commit.oid) ?? [];
      commit.boundaryParents = snapshot.shallow.has(commit.oid)
        ? [...commit.parents]
        : [];
    }
    await this.#validate(snapshot);
    const nextCursor =
      oids.length > count ? `${snapshot.id}.${randomUUID()}` : null;
    const page: GitHistoryPage = {
      path: snapshot.root,
      scope: snapshot.scope,
      snapshotId: snapshot.id,
      head: snapshot.identity.head,
      branch: snapshot.identity.branch,
      readAt: snapshot.readAt,
      commits: [...commits.values()].map(summary),
      nextCursor,
      shallow: snapshot.shallow.size > 0,
    };
    for (const [oid, commit] of commits) snapshot.commits.set(oid, commit);
    if (nextCursor) snapshot.cursors.set(nextCursor, offset + count);
    snapshot.pages.set(offset, page);
    if (publish) {
      try {
        this.#bound(snapshot);
      } catch (error) {
        snapshot.pages.delete(offset);
        if (nextCursor) snapshot.cursors.delete(nextCursor);
        for (const oid of commits.keys()) snapshot.commits.delete(oid);
        throw error;
      }
    }
    return page;
  }
  async #detail(
    snapshot: Snapshot,
    oid: string,
    parent?: string,
  ): Promise<GitCommitDetail> {
    validOid(oid);
    const commit = snapshot.commits.get(oid);
    if (!commit) throw new GitReadError("提交尚未在此历史快照中加载。", 404);
    const selected = parent ?? commit.parents[0] ?? "root";
    if (selected !== "root") validOid(selected);
    if (
      selected === "root"
        ? commit.parents.length > 0
        : !commit.parents.includes(selected)
    )
      throw new GitReadError("所选基线不是提交的实际父对象。", 400);
    const baseOid = selected === "root" ? null : selected;
    const result: GitCommitDetail = {
      path: snapshot.root,
      snapshotId: snapshot.id,
      commit,
      baseOid,
      unavailableReason: null,
      files: [],
    };
    try {
      await gitRead(snapshot.root, ["cat-file", "-e", `${oid}^{commit}`]);
    } catch (error) {
      if (error instanceof GitReadError && error.statusCode === 422)
        throw expired();
      throw error;
    }
    if (baseOid) {
      try {
        await gitRead(snapshot.root, ["cat-file", "-e", `${baseOid}^{commit}`]);
      } catch (error) {
        if (!(error instanceof GitReadError) || error.statusCode !== 422)
          throw error;
        result.unavailableReason =
          "父提交对象不可用，无法比较；请在仓库中补齐对象后刷新历史。";
        return result;
      }
    }
    result.files = parseCommitFiles(
      await gitRead(snapshot.root, [
        "diff-tree",
        "--no-commit-id",
        "-r",
        "--root",
        "--raw",
        "-z",
        "--no-abbrev",
        "--find-renames",
        "--no-ext-diff",
        "--no-textconv",
        ...(baseOid ? [baseOid] : []),
        oid,
        "--",
      ]),
    );
    return result;
  }
}
