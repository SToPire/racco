import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

const RaccoConfigSchema = z.strictObject({
  host: z.string().min(1).default("127.0.0.1"),
  port: z.number().int().min(1).max(65_535).default(7331),
  stateDir: z.string().min(1).optional(),
  worktreeRoot: z.string().min(1).optional(),
});

export type RaccoConfig = Omit<
  z.infer<typeof RaccoConfigSchema>,
  "stateDir" | "worktreeRoot"
> & {
  stateDir: string;
  worktreeRoot: string;
};

export async function loadConfig(
  configPath = resolve(process.cwd(), "racco.config.json"),
): Promise<RaccoConfig> {
  const raw = JSON.parse(await readFile(configPath, "utf8")) as unknown;
  const parsed = RaccoConfigSchema.parse(raw);
  const defaultStateHome =
    process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  const stateDir =
    parsed.stateDir === undefined
      ? join(defaultStateHome, "racco")
      : isAbsolute(parsed.stateDir)
        ? parsed.stateDir
        : resolve(dirname(configPath), parsed.stateDir);
  const defaultDataHome =
    process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  // Worktrees Racco creates live beside the daemon's other persistent state, but
  // under XDG_DATA_HOME: they are working copies the user opens in a terminal,
  // not private state. The root only constrains creation — worktrees created
  // elsewhere by hand are listed all the same.
  const worktreeRoot =
    parsed.worktreeRoot === undefined
      ? join(defaultDataHome, "racco", "worktrees")
      : isAbsolute(parsed.worktreeRoot)
        ? parsed.worktreeRoot
        : resolve(dirname(configPath), parsed.worktreeRoot);

  return {
    ...parsed,
    stateDir,
    // The README installs the checkout as a symlink at `~/.local/share/racco`,
    // so the default root reaches the filesystem through one. Git canonicalizes
    // the path it records for a worktree, and that path is the identity the
    // whole design keys on (`worktree.path === session.cwd`), so the root is
    // resolved here — once, at load — rather than compared loosely later.
    worktreeRoot: await realpath(worktreeRoot).catch(() => worktreeRoot),
  };
}
