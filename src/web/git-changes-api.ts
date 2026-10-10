import {
  GitChangeDiffSchema,
  GitChangesSchema,
  type GitChangeGroup,
} from "../shared/git-changes";

import { gitResource as resource } from "./git-request";
export { GitApiError } from "./git-request";

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
