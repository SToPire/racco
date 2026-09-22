import { isAbsolute } from "node:path";

/**
 * One `worktree` block of `git worktree list --porcelain`. `path` is the identity:
 * Git reports it authoritatively, while the directory name under
 * `.git/worktrees/` survives `git worktree move` unchanged and therefore cannot
 * be used to identify a worktree.
 */
export type ParsedWorktree = {
  path: string;
  head: string | null;
  branch: string | null;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  lockedReason: string | null;
  prunable: boolean;
  prunableReason: string | null;
};

export type ParseOutcome =
  | { kind: "ok"; worktrees: ParsedWorktree[] }
  | { kind: "empty" }
  | { kind: "malformed"; line: string };

function readKeyValue(
  lines: readonly string[],
  offset: number,
): { key: string; value: string } {
  const line = lines[offset];
  const separator = line.indexOf(" ");
  if (separator === -1) return { key: line, value: "" };
  return { key: line.slice(0, separator), value: line.slice(separator + 1) };
}

/**
 * Parses the machine-readable listing. A `worktree <path>` line always opens a
 * new block; `HEAD`, `branch`, `detached`, `bare`, `locked` and `prunable` are
 * optional lines inside it. Unknown lines are ignored so that a future Git
 * release adding a field does not break the reader.
 */
export function parseWorktreeList(stdout: string): ParseOutcome {
  const blocks: string[][] = [];
  let current: string[] | undefined;
  for (const raw of stdout.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line === "") {
      current = undefined;
      continue;
    }
    if (line.startsWith("worktree ")) {
      current = [line];
      blocks.push(current);
      continue;
    }
    if (current === undefined) {
      // A key-value line outside any block means the output is not a listing we
      // understand; report it rather than silently dropping a worktree.
      return { kind: "malformed", line };
    }
    current.push(line);
  }

  if (blocks.length === 0) return { kind: "empty" };

  const worktrees: ParsedWorktree[] = [];
  for (const block of blocks) {
    const first = block[0].slice("worktree ".length);
    if (!isAbsolute(first)) return { kind: "malformed", line: block[0] };
    let head: string | null = null;
    let branch: string | null = null;
    let bare = false;
    let detached = false;
    let locked = false;
    let lockedReason: string | null = null;
    let prunable = false;
    let prunableReason: string | null = null;
    for (let index = 1; index < block.length; index += 1) {
      const { key, value } = readKeyValue(block, index);
      switch (key) {
        case "HEAD":
          head = value === "" ? null : value;
          break;
        case "branch":
          branch = value.startsWith("refs/heads/")
            ? value.slice("refs/heads/".length)
            : value;
          break;
        case "bare":
          bare = true;
          break;
        case "detached":
          detached = true;
          break;
        case "locked":
          locked = true;
          lockedReason = value === "" ? null : value;
          break;
        case "prunable":
          prunable = true;
          prunableReason = value === "" ? null : value;
          break;
        default:
          break;
      }
    }
    worktrees.push({
      path: first,
      head,
      branch,
      bare,
      detached,
      locked,
      lockedReason,
      prunable,
      prunableReason,
    });
  }
  return { kind: "ok", worktrees };
}
