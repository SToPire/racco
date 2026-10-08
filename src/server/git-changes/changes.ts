import { constants } from "node:fs";
import { lstat, open, readlink, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, dirname } from "node:path";
import type {
  GitChangeDiff,
  GitChangeEntry,
  GitChanges,
  GitChangeGroup,
} from "../../shared/git-changes.js";
import { gitRead, GitReadError, strictText } from "./git.js";

const MAX_TEXT = 2 * 1024 * 1024;
type Entry = GitChangeEntry & { blobs: string[] };
type Snapshot = Omit<GitChanges, "entries"> & {
  entries: Entry[];
  stamp: string;
};

function within(root: string, target: string): boolean {
  const path = relative(root, target);
  return path !== ".." && !path.startsWith("../") && !isAbsolute(path);
}

export function validateGitPath(path: string): void {
  if (
    !path ||
    path.includes("\0") ||
    isAbsolute(path) ||
    path.split("/").some((part) => part === ".." || part === ".") ||
    path.length > 4096
  )
    throw new GitReadError("文件路径必须位于 Worktree 内。", 400);
}

/** -z paths are raw UTF-8 strings; only the fixed ASCII header uses spaces. */
export function parseStatus(bytes: Buffer): Entry[] {
  const rows = strictText(bytes).split("\0");
  const entries: Entry[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    if (row.startsWith("? ")) {
      const path = row.slice(2);
      validateGitPath(path);
      entries.push({
        path,
        oldPath: null,
        group: "untracked",
        status: "?",
        submodule: false,
        submoduleState: null,
        blobs: [],
      });
      continue;
    }
    const type = row[0];
    const count = type === "1" ? 8 : type === "2" ? 9 : type === "u" ? 10 : 0;
    if (!count) throw new GitReadError("无法解析 Git 状态。", 422);
    let offset = 0;
    const fields: string[] = [];
    for (let field = 0; field < count; field++) {
      const end = row.indexOf(" ", offset);
      if (end < 0) throw new GitReadError("Git 状态记录不完整。", 422);
      fields.push(row.slice(offset, end));
      offset = end + 1;
    }
    const path = row.slice(offset);
    validateGitPath(path);
    const oldPath = type === "2" ? rows[++i] : null;
    if (oldPath !== null) validateGitPath(oldPath);
    const submodule = fields[2].startsWith("S");
    const blobs = fields.slice(type === "u" ? 7 : 6, type === "u" ? 10 : 8);
    if (type === "u") {
      entries.push({
        path,
        oldPath: null,
        group: "conflict",
        status: fields[1],
        submodule,
        submoduleState: submodule ? fields[2] : null,
        blobs,
      });
    } else {
      for (const [column, group] of [
        [0, "staged"],
        [1, "unstaged"],
      ] as const) {
        const status = fields[1][column];
        if (status === ".") continue;
        entries.push({
          path,
          oldPath: status === "R" || status === "C" ? oldPath : null,
          group,
          status,
          submodule,
          submoduleState: submodule ? fields[2] : null,
          blobs,
        });
      }
    }
    if (entries.length > 1000)
      throw new GitReadError(
        "修改条目超过 1000 项，请缩小工作区修改范围。",
        413,
      );
  }
  if (entries.length > 1000)
    throw new GitReadError("修改条目超过 1000 项。", 413);
  return entries;
}

async function fingerprint(path: string): Promise<string> {
  try {
    const info = await lstat(path, { bigint: true });
    return [
      info.dev,
      info.ino,
      info.mode,
      info.size,
      info.mtimeNs,
      info.ctimeNs,
    ].join(":");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

async function snapshot(path: string): Promise<Snapshot> {
  const root = await realpath(path);
  const top = strictText(
    await gitRead(root, ["rev-parse", "--show-toplevel"]),
  ).replace(/\n$/, "");
  if ((await realpath(top)) !== root)
    throw new GitReadError(
      "所选目录不是 Git 工作区根目录，请导入仓库根目录。",
      422,
    );
  const index = strictText(
    await gitRead(root, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "index",
    ]),
  ).replace(/\n$/, "");
  const indexBefore = await fingerprint(index);
  const bytes = await gitRead(root, [
    "status",
    "--porcelain=v2",
    "-z",
    "--branch",
    "--untracked-files=all",
    "--ignore-submodules=none",
    "--renames",
  ]);
  const parts = strictText(bytes).split("\0");
  const headers: string[] = [];
  while (parts[0]?.startsWith("# ")) headers.push(parts.shift()!);
  const branchRow = headers.find((row) => row.startsWith("# branch.head "));
  const headRow = headers.find((row) => row.startsWith("# branch.oid "));
  const rawBranch = branchRow?.slice(14);
  const rawHead = headRow?.slice(13);
  const entries = parseStatus(Buffer.from(parts.join("\0")));
  const indexAfter = await fingerprint(index);
  if (indexBefore !== indexAfter)
    throw new GitReadError("工作区正在变化，请稍后刷新。", 409);
  return {
    path,
    branch: rawBranch && rawBranch !== "(detached)" ? rawBranch : null,
    head: rawHead && rawHead !== "(initial)" ? rawHead : null,
    readAt: new Date().toISOString(),
    entries,
    stamp: createHash("sha256").update(bytes).update(indexAfter).digest("hex"),
  };
}

async function stable<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (
        !(error instanceof GitReadError) ||
        error.statusCode !== 409 ||
        attempt === 1
      )
        throw error;
    }
  }
}

function publicEntry({ blobs: _blobs, ...entry }: Entry): GitChangeEntry {
  return entry;
}

async function list(path: string): Promise<GitChanges> {
  return stable(async () => {
    const before = await snapshot(path);
    const after = await snapshot(path);
    if (before.stamp !== after.stamp)
      throw new GitReadError("工作区正在变化，请稍后刷新。", 409);
    return {
      path,
      branch: after.branch,
      head: after.head,
      readAt: after.readAt,
      entries: after.entries.map(publicEntry),
    };
  });
}

function quotePath(path: string): string {
  const special = (char: string) =>
    char.charCodeAt(0) <= 32 || char === '"' || char === "\\";
  if (!Array.from(path).some(special)) return path;
  return `"${Array.from(path)
    .map((char) =>
      char === "\\"
        ? "\\\\"
        : char === '"'
          ? '\\"'
          : special(char)
            ? `\\${char.charCodeAt(0).toString(8).padStart(3, "0")}`
            : char,
    )
    .join("")}"`;
}

export function addedDiff(path: string, text: string, mode = "100644"): string {
  const header = `diff --git ${quotePath(`a/${path}`)} ${quotePath(`b/${path}`)}\nnew file mode ${mode}\n--- /dev/null\n+++ ${quotePath(`b/${path}`)}\n`;
  if (!text) return header;
  const lines = text.split("\n");
  const newline = text.endsWith("\n");
  if (newline) lines.pop();
  return `${header}@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}\n${newline ? "" : "\\ No newline at end of file\n"}`;
}

async function fileBytes(root: string, file: string): Promise<Buffer> {
  const target = resolve(root, file);
  if (!within(root, await realpath(dirname(target))))
    throw new GitReadError("文件父目录指向 Worktree 外部。", 403);
  const info = await lstat(target);
  if (info.isSymbolicLink()) return Buffer.from(await readlink(target));
  const handle = await open(
    target,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
  );
  try {
    if (!within(root, await realpath(`/proc/self/fd/${handle.fd}`)))
      throw new GitReadError("文件位于 Worktree 外部。", 403);
    const opened = await handle.stat();
    if (!opened.isFile())
      throw new GitReadError("只能读取普通文件或符号链接。", 422);
    if (opened.size > MAX_TEXT)
      throw new GitReadError("文件超过 2 MiB，无法展示差异。", 413);
    const buffer = Buffer.alloc(MAX_TEXT + 1);
    let size = 0;
    while (size < buffer.length) {
      const result = await handle.read(
        buffer,
        size,
        buffer.length - size,
        size,
      );
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size > MAX_TEXT)
      throw new GitReadError("文件超过 2 MiB，无法展示差异。", 413);
    return buffer.subarray(0, size);
  } finally {
    await handle.close();
  }
}

async function diff(
  path: string,
  file: string,
  group: GitChangeGroup,
): Promise<GitChangeDiff> {
  validateGitPath(file);
  return stable(async () => {
    const before = await snapshot(path);
    const entry = before.entries.find(
      (candidate) => candidate.path === file && candidate.group === group,
    );
    if (!entry) throw new GitReadError("修改条目已消失，请刷新。", 404);
    const root = await realpath(path);
    const paths = entry.oldPath ? [entry.oldPath, file] : [file];
    const fileBefore = await Promise.all(
      paths.map((name) => fingerprint(resolve(root, name))),
    );
    const result: GitChangeDiff = {
      path,
      file,
      oldPath: entry.oldPath,
      group,
      readAt: before.readAt,
      kind: "metadata",
      diff: "",
      reason: null,
      currentFileAvailable: await realpath(resolve(root, file))
        .then(
          async (target) =>
            within(root, target) && (await stat(target)).isFile(),
        )
        .catch(() => false),
    };
    if (group === "conflict") {
      result.kind = "conflict";
      result.reason =
        "存在未合并冲突，请查看当前文件；此处不生成 combined diff。";
    } else if (entry.submodule) {
      result.kind = "submodule";
      result.reason = `子模块状态 ${entry.submoduleState}，Git 状态 ${entry.status}；对象 ${entry.blobs.join(" → ")}。不递归读取子模块文件。`;
    } else {
      try {
        let bytes: Buffer;
        if (group === "untracked") {
          bytes = await fileBytes(root, file);
          if (bytes.includes(0)) {
            result.kind = "binary";
            result.reason = "二进制文件，无法展示文本差异。";
          } else {
            const info = await lstat(resolve(root, file));
            result.diff = addedDiff(
              file,
              strictText(bytes),
              info.isSymbolicLink()
                ? "120000"
                : info.mode & 0o111
                  ? "100755"
                  : "100644",
            );
          }
        } else {
          for (const blob of entry.blobs) {
            if (!/^[0-9a-f]{40,64}$/.test(blob) || /^0+$/.test(blob)) continue;
            const size = Number(
              strictText(await gitRead(root, ["cat-file", "-s", blob])),
            );
            if (!Number.isFinite(size) || size > MAX_TEXT)
              throw new GitReadError(
                "Git 文件对象超过 2 MiB，无法展示差异。",
                413,
              );
          }
          for (const name of paths) {
            const info = await lstat(resolve(root, name)).catch(
              (error: NodeJS.ErrnoException) => {
                if (error.code === "ENOENT") return undefined;
                throw error;
              },
            );
            if (info?.isFile() && info.size > MAX_TEXT)
              throw new GitReadError("文件超过 2 MiB，无法展示差异。", 413);
          }
          bytes = await gitRead(
            root,
            [
              "diff",
              ...(group === "staged" ? ["--cached"] : []),
              "--no-ext-diff",
              "--no-textconv",
              "--no-color",
              "--no-renames",
              "--",
              ...paths,
            ],
            MAX_TEXT,
          );
          result.diff = strictText(bytes);
          if (/^Binary files .* differ$/m.test(result.diff)) {
            result.kind = "binary";
            result.reason = "二进制文件，无法展示文本差异。";
          }
        }
        if (
          Buffer.byteLength(result.diff) > MAX_TEXT ||
          result.diff.split("\n").length > 20_000
        )
          throw new GitReadError("差异超过 2 MiB 或 20000 行。", 413);
        if (result.kind !== "binary") {
          result.kind = /^@@ /m.test(result.diff) ? "text" : "metadata";
          if (result.kind === "metadata")
            result.reason = "仅元数据或空文件变化。";
        }
      } catch (error) {
        if (
          error instanceof GitReadError &&
          [413, 422].includes(error.statusCode)
        ) {
          result.kind = "unavailable";
          result.diff = "";
          result.reason = error.message;
        } else throw error;
      }
    }
    const after = await snapshot(path);
    const fileAfter = await Promise.all(
      paths.map((name) => fingerprint(resolve(root, name))),
    );
    if (
      before.stamp !== after.stamp ||
      fileBefore.join("|") !== fileAfter.join("|")
    )
      throw new GitReadError("文件正在变化，请稍后刷新。", 409);
    result.readAt = after.readAt;
    return result;
  });
}

/** Coalesce lists and refuse a second active read instead of an unbounded queue. */
export class GitChangesReader {
  readonly #active = new Map<string, Promise<unknown>>();
  readonly #lists = new Map<string, Promise<GitChanges>>();

  list(path: string): Promise<GitChanges> {
    const current = this.#lists.get(path);
    if (current) return current;
    const task = this.#run(path, () => list(path));
    this.#lists.set(path, task);
    void task.finally(() => this.#lists.delete(path)).catch(() => {});
    return task;
  }

  diff(
    path: string,
    file: string,
    group: GitChangeGroup,
  ): Promise<GitChangeDiff> {
    return this.#run(path, () => diff(path, file, group));
  }

  #run<T>(path: string, operation: () => Promise<T>): Promise<T> {
    if (this.#active.has(path))
      return Promise.reject(
        new GitReadError("Git 读取繁忙，请稍后重试。", 409),
      );
    const task = operation();
    this.#active.set(path, task);
    void task.finally(() => this.#active.delete(path)).catch(() => {});
    return task;
  }
}
