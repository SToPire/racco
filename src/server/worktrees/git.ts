import { execFile } from "node:child_process";

export class GitCommandError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(GitCommandError.describe(args, exitCode, stderr));
    this.name = "GitCommandError";
  }

  private static describe(
    args: readonly string[],
    exitCode: number | null,
    stderr: string,
  ): string {
    // Git wraps a message across lines (the locked-worktree refusal, for
    // instance), so collapsing whitespace keeps the whole message rather than
    // the last fragment of it.
    const summary = stderr.trim().replaceAll(/\s+/g, " ");
    return summary === ""
      ? `git ${args.join(" ")} failed (exit ${exitCode ?? "unknown"})`
      : summary;
  }
}

/**
 * Raised when `git` itself is unusable — not installed, or not executable. Kept
 * distinct from GitCommandError so callers can separate "this directory is not a
 * repository" (a normal answer) from "we could not ask" (never a normal answer).
 */
export class GitUnavailableError extends Error {
  constructor(cause: unknown) {
    super("找不到可执行的 git，无法读取 Worktree");
    this.name = "GitUnavailableError";
    this.cause = cause;
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * The repository's common Git directory — the same value for a main working tree
 * and all of its linked worktrees. It identifies "the repository" independently
 * of any checkout's path, which is what makes it usable as a duplicate-project
 * guard. Returns undefined when the directory is not in a repository, or when Git
 * cannot be asked at all.
 */
export async function gitCommonDir(path: string): Promise<string | undefined> {
  try {
    const stdout = await runGit(
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: path },
    );
    const resolved = stdout.trim();
    return resolved === "" ? undefined : resolved;
  } catch (error) {
    if (error instanceof GitUnavailableError) throw error;
    return undefined;
  }
}

/**
 * Runs git with a fixed argument list, never through a shell, so a path
 * containing spaces or quotes cannot be reinterpreted as an option.
 */
export function runGit(
  args: readonly string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(
      "git",
      [...args],
      {
        cwd: options.cwd,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve(stdout);
          return;
        }
        // `execFile` reports a missing binary as the string code `ENOENT`, and a
        // Git failure as the numeric exit code. A killed process carries neither,
        // which also means "we could not ask" rather than "there is nothing".
        if (error.code === "ENOENT") {
          reject(new GitUnavailableError(error));
          return;
        }
        const exitCode = typeof error.code === "number" ? error.code : null;
        if (exitCode === null) {
          reject(new GitUnavailableError(error));
          return;
        }
        reject(new GitCommandError(args, exitCode, stderr));
      },
    );
  });
}
