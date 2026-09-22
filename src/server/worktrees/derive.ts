import { realpath, stat } from "node:fs/promises";
import { isAbsolute, parse } from "node:path";
import { GitCommandError, GitUnavailableError, runGit } from "./git.js";
import { parseWorktreeList } from "./porcelain.js";

export type WorktreeKind = "primary" | "linked";

export type DerivedWorktree = {
  /** Absolute path. The identity of a worktree. */
  path: string;
  kind: WorktreeKind;
  /** Last path segment, for display only. */
  name: string;
  branch: string | null;
  head: string | null;
  available: boolean;
  locked: boolean;
  prunable: boolean;
  /** Git refuses to remove a main working tree; mirrored for the UI. */
  removable: boolean;
};

export type DerivedCatalog = {
  worktrees: DerivedWorktree[];
  /** Reason the listing is degraded; the entry list is then not authoritative. */
  degradedReason: string | null;
};

function realpathOrSelf(path: string): Promise<string> {
  return realpath(path).catch(() => path);
}

/**
 * Raised when the listing could not be obtained. Git always lists at least the
 * repository's own checkout, so a zero-row answer for a Git repository is
 * structurally impossible and can only mean the read failed. Publishing that as
 * "this project has no worktrees" would orphan every session under it, so the
 * empty case is an error rather than an answer.
 */
export class WorktreeCatalogUnavailableError extends Error {
  constructor(
    readonly projectPath: string,
    readonly reason: string,
  ) {
    super(`无法读取项目 ${projectPath} 的 Worktree 列表：${reason}`);
    this.name = "WorktreeCatalogUnavailableError";
  }
}

function displayName(path: string): string {
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  const segments = trimmed.split("/").filter((segment) => segment !== "");
  return segments.at(-1) ?? trimmed;
}

async function directoryIsAvailable(path: string): Promise<boolean> {
  if (!isAbsolute(path)) return false;
  try {
    const canonical = await realpath(path);
    if (canonical === parse(canonical).root) return false;
    return (await stat(canonical)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Whether `path` is the main working tree of its repository, as opposed to a
 * linked worktree or a plain directory.
 *
 * The check is `rev-parse --git-dir` rather than "is a Git repository", because
 * running `worktree add` from inside a linked worktree also succeeds: only the
 * admin directory distinguishes them. `--path-format=absolute` is required —
 * without it Git answers a relative `.git`, which cannot be compared against the
 * project path.
 *
 * `false` is only ever Git's answer. Being unable to ask propagates, so a missing
 * `git` cannot be reported to the user as "this project is not a main working
 * tree".
 */
export async function isMainWorkingTree(path: string): Promise<boolean> {
  const canonicalPath = await realpathOrSelf(path);
  let stdout: string;
  try {
    stdout = await runGit(
      ["rev-parse", "--path-format=absolute", "--git-dir"],
      {
        cwd: canonicalPath,
      },
    );
  } catch (error) {
    // Git ran and answered: a plain directory is simply not a main working
    // tree. Being unable to run Git at all is a different answer and propagates.
    if (error instanceof GitUnavailableError) throw error;
    return false;
  }
  const gitDir = stdout.trim();
  if (gitDir === "") return false;
  return (await realpathOrSelf(gitDir)) === `${canonicalPath}/.git`;
}

/**
 * The catalog that can always be reported when the listing is unavailable: the
 * project directory is its own main worktree, so a project is never empty even
 * when Git cannot be asked. `reason` is null when the situation is normal (a
 * non-Git directory) rather than a degradation.
 */
export async function primaryOnlyCatalog(
  projectPath: string,
  reason: string | null,
  displayPath?: string,
): Promise<DerivedCatalog> {
  return {
    worktrees: [
      {
        path: projectPath,
        kind: "primary",
        name: displayName(displayPath ?? projectPath),
        branch: null,
        head: null,
        available: await directoryIsAvailable(projectPath),
        locked: false,
        prunable: false,
        removable: false,
      },
    ],
    degradedReason: reason,
  };
}

/**
 * Derives a project's worktrees from Git. The primary worktree is the project
 * itself and is synthesized — never matched by path string against Git's output,
 * so a path that differs only by symlink or trailing slash cannot turn the
 * project directory into a deletable linked entry.
 *
 * Returns a degraded catalog instead of throwing when the listing fails but a
 * previous view can be kept by the caller; throws only for the empty case, which
 * callers must not treat as an answer.
 */
export async function deriveWorktrees(options: {
  projectPath: string;
  /** Anchor for the primary entry; defaults to `projectPath`. */
  displayPath?: string;
}): Promise<DerivedCatalog> {
  const { projectPath } = options;

  if (!(await directoryIsAvailable(projectPath))) {
    // The project directory is gone. That is a degraded view, not a failure to
    // read: only the primary entry can be reported.
    return primaryOnlyCatalog(
      projectPath,
      `项目目录不可用：${projectPath}`,
      options.displayPath,
    );
  }

  let stdout: string;
  try {
    stdout = await runGit(["worktree", "list", "--porcelain"], {
      cwd: projectPath,
    });
  } catch (error) {
    if (error instanceof GitUnavailableError) {
      return primaryOnlyCatalog(
        projectPath,
        error.message,
        options.displayPath,
      );
    }
    if (error instanceof GitCommandError) {
      // `not a git repository` is a normal answer: a plain directory imports
      // fine and simply has no linked worktrees.
      const notARepository = /not a git repository/i.test(error.stderr);
      return primaryOnlyCatalog(
        projectPath,
        notARepository ? null : error.message,
        options.displayPath,
      );
    }
    return primaryOnlyCatalog(
      projectPath,
      error instanceof Error ? error.message : String(error),
      options.displayPath,
    );
  }

  const parsed = parseWorktreeList(stdout);
  if (parsed.kind === "empty" || parsed.kind === "malformed") {
    const reason =
      parsed.kind === "empty"
        ? "git worktree list 返回空结果"
        : `无法解析 git worktree list 的输出：${parsed.line}`;
    throw new WorktreeCatalogUnavailableError(projectPath, reason);
  }

  const linked = await Promise.all(
    parsed.worktrees.map(
      async (entry): Promise<DerivedWorktree | undefined> => {
        const canonicalPrimary = await realpathOrSelf(projectPath);
        const canonicalEntry = await realpathOrSelf(entry.path);
        // Defense in depth: Git refuses to remove a main working tree, but an
        // entry that resolves to the project directory must never be presented as
        // removable either.
        if (canonicalEntry === canonicalPrimary) return undefined;
        const available = await directoryIsAvailable(entry.path);
        return {
          path: entry.path,
          kind: "linked",
          name: displayName(entry.path),
          branch: entry.detached ? null : entry.branch,
          head: entry.head,
          available,
          locked: entry.locked,
          prunable: entry.prunable,
          removable: true,
        };
      },
    ),
  );

  return {
    worktrees: [
      ...(await primaryOnlyCatalog(projectPath, null, options.displayPath))
        .worktrees,
      ...linked.filter((entry) => entry !== undefined),
    ],
    degradedReason: null,
  };
}
