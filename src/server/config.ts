import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

const RaccoConfigSchema = z.strictObject({
  host: z.string().min(1).default("127.0.0.1"),
  port: z.number().int().min(1).max(65_535).default(7331),
  stateDir: z.string().min(1).optional(),
});

export type RaccoConfig = Omit<
  z.infer<typeof RaccoConfigSchema>,
  "stateDir"
> & {
  stateDir: string;
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

  return {
    ...parsed,
    stateDir,
  };
}
