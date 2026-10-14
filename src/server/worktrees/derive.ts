import { realpath, stat } from "node:fs/promises";
import { isAbsolute, parse } from "node:path";
import { GitCommandError, GitUnavailableError, runGit } from "./git.js";
import { parseWorktreeList, type ParsedWorktree } from "./porcelain.js";
import { resolveProjectDirectory } from "../project-path.js";

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
    super(`Cannot read worktrees for project ${projectPath}: ${reason}`);
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
        ? "git worktree list returned an empty result"
        : `Cannot parse git worktree list output: ${parsed.line}`;
    throw new WorktreeCatalogUnavailableError(path, reason);
  }
  return parsed.worktrees;
}

async function workingTreeIdentity(path: string) {
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
  if (!root || !gitDirectory || !commonDirectory)
    throw new Error(`Invalid Git worktree identity for ${path}`);
  const common = await realpath(commonDirectory);
  return {
    root: await realpath(root),
    common,
    main: (await realpath(gitDirectory)) === common,
  };
}

/** A linked root imports its main worktree; subdirectories and bare repos fail. */
export async function resolveProjectRoot(
  path: string,
  entries?: ParsedWorktree[],
): Promise<string> {
  try {
    entries ??= await readGitWorktrees(path);
  } catch (error) {
    if (
      error instanceof GitCommandError &&
      /not a git repository \(or any /i.test(error.stderr)
    )
      return path;
    throw error;
  }
  if (entries[0].bare)
    throw new Error("Bare Git repositories cannot be imported as projects");
  const identity = await workingTreeIdentity(path);
  if (identity.root !== (await realpath(path)))
    throw new Error(`Select a Git worktree root directory: ${identity.root}`);
  if (identity.main) return identity.root;
  const mainRoot = await resolveProjectDirectory(entries[0].path);
  if (!mainRoot)
    throw new Error(`Main worktree is unavailable: ${entries[0].path}`);
  const mainIdentity = await workingTreeIdentity(mainRoot);
  if (
    !mainIdentity.main ||
    mainIdentity.root !== mainRoot ||
    mainIdentity.common !== identity.common
  )
    throw new Error(`Cannot resolve main worktree for ${path}: ${mainRoot}`);
  return mainRoot;
}

/** Git's main root is the only directory from which Racco creates worktrees. */
export async function isMainWorkingTree(path: string): Promise<boolean> {
  try {
    const identity = await workingTreeIdentity(path);
    return identity.main && identity.root === (await realpath(path));
  } catch (error) {
    if (error instanceof GitCommandError) return false;
    throw error;
  }
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
 * Derives a project's worktrees from Git after checking that the project is
 * actually its main root. The primary row is synthesized only after that check;
 * invalid registrations cannot turn Git's real main worktree into a linked row.
 *
 * Returns a degraded catalog when Git is unavailable. Invalid listings and
 * non-main project roots fail explicitly rather than inventing worktree roles.
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
      `Project directory is unavailable: ${projectPath}`,
      options.displayPath,
    );
  }

  let entries: ParsedWorktree[];
  try {
    entries = await readGitWorktrees(projectPath);
  } catch (error) {
    if (error instanceof WorktreeCatalogUnavailableError) throw error;
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
      return primaryOnlyCatalog(
        projectPath,
        /not a git repository/i.test(error.stderr) ? null : error.message,
        options.displayPath,
      );
    }
    return primaryOnlyCatalog(
      projectPath,
      error instanceof Error ? error.message : String(error),
      options.displayPath,
    );
  }

  const mainRoot = await resolveProjectRoot(projectPath, entries);
  if (mainRoot !== (await realpath(projectPath)))
    throw new Error(`Project must be the main worktree root: ${mainRoot}`);

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
      ...(await primaryOnlyCatalog(projectPath, null, options.displayPath))
        .worktrees,
      ...linked.filter((entry) => entry !== undefined),
    ],
    degradedReason: null,
  };
}
