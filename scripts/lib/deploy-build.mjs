import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { root } from "./process.mjs";

const exec = promisify(execFile);
const unit = "raccod.service";

// All mutations happen while the service is stopped. Keep the preceding build
// until the new daemon confirms its build ID, including failures after start.
export async function deployBuild({ output, build, service }) {
  const previous = JSON.parse(
    await readFile(join(output, "build-info.json"), "utf8"),
  );
  const directory = await mkdtemp(join(output, "../.tmp/deploy-"));
  const backup = join(directory, "dist");
  let moved = false;
  try {
    await service.stop();
    await rename(output, backup);
    moved = true;
    const result = await build();
    await service.start();
    await service.ready(result.info);
    await rm(directory, { recursive: true, force: true });
    return result;
  } catch (failure) {
    try {
      await service.stop();
      if (moved) {
        await rm(output, { recursive: true, force: true });
        await rename(backup, output);
      }
      await service.start();
      await service.ready(previous);
      await rm(directory, { recursive: true, force: true });
    } catch (recovery) {
      throw new AggregateError(
        [failure, recovery],
        `Deployment and recovery failed; inspect ${directory}`,
      );
    }
    throw failure;
  }
}

export async function productionBuild(
  build,
  { checkout = root, entry = join(homedir(), ".local/share/racco") } = {},
) {
  // Uninstalled checkouts can build without a user bus or runtime config.
  if ((await realpath(entry).catch(() => null)) !== (await realpath(checkout)))
    return build();
  let stdout;
  try {
    ({ stdout } = await exec("systemctl", [
      "--user",
      "show",
      unit,
      "--property=ActiveState",
      "--property=WorkingDirectory",
    ]));
  } catch (error) {
    throw new Error(
      "Cannot check the installed user service; restore the systemd user bus or use npm run build:check for an offline validation build",
      { cause: error },
    );
  }
  const properties = Object.fromEntries(
    stdout
      .trim()
      .split("\n")
      .map((line) => {
        const split = line.indexOf("=");
        return [line.slice(0, split), line.slice(split + 1)];
      }),
  );
  if (["inactive", "failed"].includes(properties.ActiveState)) return build();
  if (
    (await realpath(properties.WorkingDirectory)) !== (await realpath(checkout))
  )
    return build();
  const { loadConfig } = await import("../../src/server/config.ts");
  const config = await loadConfig(join(checkout, "racco.config.json"));
  const host =
    config.host === "0.0.0.0"
      ? "127.0.0.1"
      : config.host === "::"
        ? "::1"
        : config.host;
  const url = `http://${host.includes(":") ? `[${host}]` : host}:${config.port ?? 7331}/api/diagnostics`;
  const service = {
    stop: () => exec("systemctl", ["--user", "stop", unit]),
    start: () => exec("systemctl", ["--user", "start", unit]),
    async ready(info) {
      for (let attempt = 0; attempt < 50; attempt++) {
        try {
          const response = await fetch(url, {
            signal: AbortSignal.timeout(500),
          });
          if (response.ok && (await response.json()).build?.id === info.id)
            return;
        } catch {
          /* startup may not have opened the listener yet */
        }
        await delay(200);
      }
      throw new Error(`Daemon did not become ready with build ${info.id}`);
    },
  };
  return deployBuild({ output: join(checkout, "dist"), build, service });
}
