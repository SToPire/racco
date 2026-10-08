import {
  GitChangeDiffSchema,
  GitChangesSchema,
  type GitChangeGroup,
} from "../shared/git-changes";

export class GitApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function resource(
  name: string,
  query: URLSearchParams,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await fetch(`/api/worktrees/${name}?${query}`, { signal });
  const data = (await response.json()) as unknown;
  if (!response.ok) {
    const message =
      typeof data === "object" &&
      data !== null &&
      "message" in data &&
      typeof data.message === "string"
        ? data.message
        : "无法读取 Git 修改。";
    throw new GitApiError(message, response.status);
  }
  return data;
}

export async function listGitChanges(path: string, signal: AbortSignal) {
  const data = GitChangesSchema.parse(
    await resource("changes", new URLSearchParams({ path }), signal),
  );
  if (data.path !== path) throw new Error("Git 修改响应与当前 Worktree 不符。");
  return data;
}

export async function readGitDiff(
  path: string,
  file: string,
  group: GitChangeGroup,
  signal: AbortSignal,
) {
  const data = GitChangeDiffSchema.parse(
    await resource(
      "change-diff",
      new URLSearchParams({ path, file, group }),
      signal,
    ),
  );
  if (data.path !== path || data.file !== file || data.group !== group)
    throw new Error("Git 差异响应与选中条目不符。");
  return data;
}
