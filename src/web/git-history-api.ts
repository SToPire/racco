import {
  GitHistoryPageSchema,
  GitCommitDetailSchema,
  GitCommitDiffSchema,
  type GitHistoryScope,
} from "../shared/git-history";
import { gitResource } from "./git-request";

export async function listGitHistory(
  path: string,
  scope: GitHistoryScope,
  signal: AbortSignal,
  cursor?: string,
) {
  const query = new URLSearchParams({ path, scope });
  if (cursor) query.set("cursor", cursor);
  const data = GitHistoryPageSchema.parse(
    await gitResource("commits", query, signal),
  );
  if (data.path !== path || data.scope !== scope)
    throw new Error("提交历史响应与当前范围不符。");
  return data;
}

export async function readGitCommit(
  path: string,
  snapshotId: string,
  oid: string,
  parent: string | undefined,
  signal: AbortSignal,
) {
  const query = new URLSearchParams({ path, snapshotId, oid });
  if (parent) query.set("parent", parent);
  const data = GitCommitDetailSchema.parse(
    await gitResource("commit", query, signal),
  );
  if (
    data.path !== path ||
    data.snapshotId !== snapshotId ||
    data.commit.oid !== oid ||
    (parent !== undefined &&
      data.baseOid !== (parent === "root" ? null : parent))
  )
    throw new Error("提交详情响应与选中提交不符。");
  return data;
}

export async function readGitCommitDiff(
  path: string,
  snapshotId: string,
  oid: string,
  parent: string,
  file: string,
  signal: AbortSignal,
) {
  const query = new URLSearchParams({ path, snapshotId, oid, parent, file });
  const data = GitCommitDiffSchema.parse(
    await gitResource("commit-diff", query, signal),
  );
  if (
    data.path !== path ||
    data.snapshotId !== snapshotId ||
    data.oid !== oid ||
    data.file !== file ||
    data.baseOid !== (parent === "root" ? null : parent)
  )
    throw new Error("提交差异响应与选中条目不符。");
  return data;
}

/** UTF-8 bytes, including metadata, bound both list and patch storage. */
export function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export class GitPatchCache<T> {
  private entries = new Map<string, { value: T; bytes: number }>();
  private bytes = 0;
  constructor(private readonly limit = 8 * 1024 * 1024) {}
  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }
  set(key: string, value: T) {
    const old = this.entries.get(key);
    if (old) {
      this.entries.delete(key);
      this.bytes -= old.bytes;
    }
    const bytes = jsonBytes(value);
    if (bytes > this.limit) return;
    while (this.bytes + bytes > this.limit) {
      const first = this.entries.keys().next().value!;
      this.bytes -= this.entries.get(first)!.bytes;
      this.entries.delete(first);
    }
    this.entries.set(key, { value, bytes });
    this.bytes += bytes;
  }
  clear() {
    this.entries.clear();
    this.bytes = 0;
  }
}
