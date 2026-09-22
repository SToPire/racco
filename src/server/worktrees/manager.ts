import { createHash } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { deriveWorktrees, isMainWorkingTree } from "./derive.js";
import type { DerivedCatalog } from "./derive.js";
import { GitCommandError, GitUnavailableError, runGit } from "./git.js";

export class WorktreeNameError extends Error {
  constructor(
    readonly name: string,
    readonly reason: string,
  ) {
    super(`无法用作 Worktree 名称：${name}（${reason}）`);
    this.name = "WorktreeNameError";
  }
}

export class WorktreeTargetExistsError extends Error {
  constructor(readonly path: string) {
    super(`目标目录已存在：${path}`);
    this.name = "WorktreeTargetExistsError";
  }
}

export class WorktreeNotLinkedError extends Error {
  constructor(readonly path: string) {
    super(`该路径不是本项目的链接 Worktree：${path}`);
    this.name = "WorktreeNotLinkedError";
  }
}

export class WorktreeDirtyError extends Error {
  constructor() {
    super("该 Worktree 含未提交的修改或未跟踪的文件，删除会一并丢弃，无法恢复");
    this.name = "WorktreeDirtyError";
  }
}

/**
 * Validates a name that doubles as a Git branch name. Git is the authority: a
 * name is legal exactly when `git check-ref-format --branch` accepts it, which
 * keeps ref-format trivia in one place instead of duplicating it here.
 */
export async function validateWorktreeName(
  name: string,
  cwd: string,
): Promise<void> {
  if (name.trim() === "") throw new WorktreeNameError(name, "名称不能为空");
  try {
    await runGit(["check-ref-format", "--branch", name], { cwd });
  } catch (error) {
    if (error instanceof GitUnavailableError) throw error;
    if (error instanceof GitCommandError)
      throw new WorktreeNameError(name, error.message);
    throw error;
  }
}

/** Directory name for a worktree: the branch name with `/` flattened to `-`. */
export function worktreeDirectoryName(name: string): string {
  return name.replaceAll("/", "-");
}

/**
 * Directory under the worktree root that holds one project's worktrees. The
 * project's basename alone would collide: two unrelated repositories can both be
 * called `repo`, and they would then contend for the same directory. The short
 * digest is over the absolute path, which is the project's identity.
 */
export function projectSlug(projectPath: string): string {
  const digest = createHash("sha256").update(projectPath).digest("hex");
  return `${basename(projectPath)}-${digest.slice(0, 8)}`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a worktree holds work that `git worktree remove` would discard. The
 * question is asked inside the worktree — running it from the project directory
 * fails with "outside repository" — and without `--force`, so a dirty directory
 * stays the user's decision rather than Git's.
 */
export async function worktreeIsDirty(path: string): Promise<boolean> {
  return (
    (
      await runGit(["status", "--porcelain", "--untracked-files=all"], {
        cwd: path,
      })
    ).trim() !== ""
  );
}

export type CreateWorktreeInput = {
  projectPath: string;
  worktreeRoot: string;
  name: string;
  baseRef?: string;
};

/**
 * Creates a linked worktree and returns the refreshed catalog. The caller owns
 * serialization; the target path is derived from the project's absolute path,
 * not from its display name, so two projects sharing a basename cannot collide.
 */
export async function createWorktree(
  input: CreateWorktreeInput,
): Promise<DerivedCatalog> {
  const { projectPath, worktreeRoot, name } = input;

  if (!(await isMainWorkingTree(projectPath))) {
    throw new Error(
      `项目目录不是 Git 主工作区，无法创建 Worktree：${projectPath}`,
    );
  }
  await validateWorktreeName(name, projectPath);
  const directory = join(worktreeRoot, projectSlug(projectPath));
  const target = join(directory, worktreeDirectoryName(name));
  if (await exists(target)) throw new WorktreeTargetExistsError(target);

  await mkdir(directory, { recursive: true, mode: 0o700 });

  const args = ["worktree", "add", "-b", name, target];
  if (input.baseRef !== undefined) args.push(input.baseRef);
  try {
    await runGit(args, { cwd: projectPath, timeoutMs: 120_000 });
  } catch (error) {
    // A failed `worktree add` can leave a partial checkout behind (an
    // interrupted checkout, a failing hook). The directory is one Racco just
    // created and no one has worked in, so removing it is not destructive.
    await rm(target, { force: true, recursive: true }).catch(() => undefined);
    throw error;
  }

  return deriveWorktrees({ projectPath });
}

export type RemoveWorktreeInput = {
  projectPath: string;
  path: string;
  force?: boolean;
};

/**
 * Removes a linked worktree from disk. The project's own directory can never be
 * the target: the check is `kind === "linked"` against the derived catalog, not
 * a comparison of path strings, so a request naming the project path matches no
 * linked entry and is refused here.
 *
 * Git's refusal to remove a main working tree, even with `--force`, stays behind
 * this as the second line of defense.
 */
export async function removeWorktree(
  input: RemoveWorktreeInput,
): Promise<DerivedCatalog> {
  const catalog = await deriveWorktrees({ projectPath: input.projectPath });
  const entry = catalog.worktrees.find(
    (candidate) => candidate.path === input.path && candidate.kind === "linked",
  );
  if (entry === undefined) throw new WorktreeNotLinkedError(input.path);

  if (!input.force && entry.available && (await worktreeIsDirty(entry.path))) {
    throw new WorktreeDirtyError();
  }
  // Let Git check again at removal time: another process can write after our
  // status check. A missing directory needs no status call or forced removal.
  const args = ["worktree", "remove"];
  if (input.force === true) args.push("--force");
  args.push(entry.path);
  try {
    await runGit(args, { cwd: input.projectPath });
  } catch (error) {
    if (
      !input.force &&
      error instanceof GitCommandError &&
      /contains modified or untracked files/.test(error.stderr)
    ) {
      throw new WorktreeDirtyError();
    }
    throw error;
  }
  return deriveWorktrees({ projectPath: input.projectPath });
}

export type CascadeRemoval = {
  path: string;
  removed: boolean;
  /** Set when the caller asked for this directory to be kept, not a failure. */
  skipped?: boolean;
  reason?: string;
};

/**
 * Removes every linked worktree of a project, as part of deleting the project.
 * One worktree that fails does not block the rest: failures are reported so the
 * caller can name the directories that may remain, rather than leaving the user
 * with a project that cannot be deleted.
 *
 * The project's main working tree has no removal entry here and is never touched.
 *
 * `skipPaths` names linked worktrees whose directories are deliberately kept
 * (the caller refuses to force-remove a live turn's directory underneath it).
 * They are reported as kept, not as failures.
 */
export async function removeAllLinkedWorktrees(
  projectPath: string,
  skipPaths?: ReadonlySet<string>,
): Promise<CascadeRemoval[]> {
  const catalog = await deriveWorktrees({ projectPath });
  const removals: CascadeRemoval[] = [];
  for (const entry of catalog.worktrees) {
    if (entry.kind !== "linked") continue;
    if (skipPaths?.has(entry.path)) {
      removals.push({
        path: entry.path,
        removed: false,
        skipped: true,
        reason: "目录下有正在进行的对话，已保留",
      });
      continue;
    }
    try {
      await runGit(["worktree", "remove", "--force", entry.path], {
        cwd: projectPath,
      });
      removals.push({ path: entry.path, removed: true });
    } catch (error) {
      removals.push({
        path: entry.path,
        removed: false,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return removals;
}
