import { realpath, stat } from "node:fs/promises";
import { isAbsolute, parse } from "node:path";
import { GitCommandError, GitUnavailableError, runGit } from "./git.js";
import { parseWorktreeList, type ParsedWorktree } from "./porcelain.js";

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

async function readGitWorktrees(path: string): Promise<ParsedWorktree[]> {
  const stdout = await runGit(["worktree", "list", "--porcelain"], {
    cwd: path,
  });
  const parsed = parseWorktreeList(stdout);
  if (parsed.kind !== "ok") {
    const reason =
      parsed.kind === "empty"
        ? "git worktree list 返回空结果"
        : `无法解析 git worktree list 的输出：${parsed.line}`;
    throw new WorktreeCatalogUnavailableError(path, reason);
  }
  return parsed.worktrees;
}

function isNotRepository(error: unknown): boolean {
  return (
    error instanceof GitCommandError &&
    /not a git repository/i.test(error.stderr)
  );
}

async function requireMainRoot(
  path: string,
  entries: ParsedWorktree[],
): Promise<void> {
  if (entries[0].bare)
    throw new Error("裸 Git 仓库不能作为项目，请选择带工作文件的主工作区");
  const mainRoot = await mainWorkingTreeRoot(path);
  if (mainRoot !== (await realpathOrSelf(path))) {
    throw new Error(
      `Git 项目必须选择主工作区根目录：${mainRoot ?? entries[0].path}`,
    );
  }
}

/** Import accepts a plain directory or the repository's actual main root. */
export async function assertProjectRoot(path: string): Promise<void> {
  let entries: ParsedWorktree[];
  try {
    entries = await readGitWorktrees(path);
  } catch (error) {
    if (isNotRepository(error)) return;
    throw error;
  }
  await requireMainRoot(path, entries);
}

async function mainWorkingTreeRoot(path: string): Promise<string | undefined> {
  try {
    const identity = await runGit(
      [
        "rev-parse",
        "--path-format=absolute",
        "--show-toplevel",
        "--git-dir",
        "--git-common-dir",
      ],
      { cwd: path },
    );
    const [root, gitDirectory, commonDirectory] = identity.trim().split("\n");
    if (!root || !gitDirectory || !commonDirectory) return undefined;
    // Subdirectories share the Git directory but are not the working root;
    // linked roots have a separate admin directory below the common directory.
    if (
      (await realpathOrSelf(gitDirectory)) !==
      (await realpathOrSelf(commonDirectory))
    )
      return undefined;
    return realpathOrSelf(root);
  } catch (error) {
    if (error instanceof GitCommandError) return undefined;
    throw error;
  }
}

/** Git's main root is the only directory from which Racco creates worktrees. */
export async function isMainWorkingTree(path: string): Promise<boolean> {
  return (await mainWorkingTreeRoot(path)) === (await realpathOrSelf(path));
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
): Promise<DerivedCatalog> {
  return {
    worktrees: [
      {
        path: projectPath,
        kind: "primary",
        name: displayName(projectPath),
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
 * Derives a project's worktrees from Git after checking that the project is
 * actually its main root. The primary row is synthesized only after that check;
 * invalid registrations cannot turn Git's real main worktree into a linked row.
 *
 * Returns a degraded catalog when Git is unavailable. Invalid listings and
 * non-main project roots fail explicitly rather than inventing worktree roles.
 */
export async function deriveWorktrees(options: {
  projectPath: string;
}): Promise<DerivedCatalog> {
  const { projectPath } = options;

  if (!(await directoryIsAvailable(projectPath))) {
    // The project directory is gone. That is a degraded view, not a failure to
    // read: only the primary entry can be reported.
    return primaryOnlyCatalog(projectPath, `项目目录不可用：${projectPath}`);
  }

  let entries: ParsedWorktree[];
  try {
    entries = await readGitWorktrees(projectPath);
  } catch (error) {
    if (error instanceof WorktreeCatalogUnavailableError) throw error;
    if (error instanceof GitUnavailableError) {
      return primaryOnlyCatalog(projectPath, error.message);
    }
    if (error instanceof GitCommandError) {
      // `not a git repository` is a normal answer: a plain directory imports
      // fine and simply has no linked worktrees.
      return primaryOnlyCatalog(
        projectPath,
        isNotRepository(error) ? null : error.message,
      );
    }
    return primaryOnlyCatalog(
      projectPath,
      error instanceof Error ? error.message : String(error),
    );
  }

  await requireMainRoot(projectPath, entries);

  const linked = await Promise.all(
    // Git's first entry is its main worktree, even when its path spells a
    // separate admin directory. Its role must never become linked/removable.
    entries
      .slice(1)
      .map(async (entry): Promise<DerivedWorktree | undefined> => {
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
      }),
  );

  return {
    worktrees: [
      ...(await primaryOnlyCatalog(projectPath, null)).worktrees,
      ...linked.filter((entry) => entry !== undefined),
    ],
    degradedReason: null,
  };
}
