import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "./build.mjs";
import { root } from "./lib/process.mjs";
import { withFileLock } from "./lib/file-lock.mjs";
import { cancellationSignals } from "./lib/signals.mjs";
const exec = promisify(execFile);
export const unit = `racco-preview-${createHash("sha256").update(root).digest("hex").slice(0, 12)}.service`;
const infoPath = join(root, ".tmp/preview.json");
const lockPath = join(root, ".tmp/locks/preview.lock");
async function active() {
  try {
    const { stdout } = await exec("systemctl", ["--user", "is-active", unit]);
    return stdout.trim() === "active";
  } catch (error) {
    if ([3, 4].includes(error.code)) return false;
    throw error;
  }
}
async function unitToken() {
  const { stdout } = await exec("systemctl", [
    "--user",
    "show",
    unit,
    "--property=Environment",
    "--value",
  ]);
  return /(?:^|\s)RACCO_PREVIEW_TOKEN=([a-f0-9-]{36})(?:\s|$)/.exec(
    stdout,
  )?.[1];
}
async function receipt() {
  return readFile(infoPath, "utf8")
    .then(JSON.parse)
    .catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
}
async function stopOwned(token) {
  if ((await unitToken()) !== token) return false;
  await exec("systemctl", ["--user", "stop", unit]);
  if (await active())
    throw new Error("Preview is still active; refusing cleanup");
  return true;
}
export async function stopPreview({ token } = {}) {
  return withFileLock(lockPath, async () => {
    const info = await receipt();
    const owner = await unitToken();
    if (token !== undefined && owner !== undefined && owner !== token)
      return { stopped: false, reason: "ownership-changed", unit };
    if (owner !== undefined) {
      if (!info || info.unit !== unit || info.token !== owner)
        throw new Error(
          "Preview receipt does not match running unit; refusing to stop another owner",
        );
      await stopOwned(owner);
    } else if (await active())
      throw new Error("Preview unit has no current ownership token");
    if (info) {
      if (token !== undefined && info.token !== token)
        return { stopped: false, reason: "ownership-changed", unit };
      const expected = join(root, ".tmp/previews", info.token ?? "");
      if (
        info.unit !== unit ||
        !/^[a-f0-9-]{36}$/.test(info.token ?? "") ||
        info.directory !== expected
      )
        throw new Error(
          "Invalid preview receipt; retained files for inspection",
        );
      await rm(expected, { recursive: true, force: true });
      await rm(infoPath, { force: true });
    }
    return { stopped: true, unit };
  });
}
export async function startPreview({ signal }) {
  return withFileLock(
    lockPath,
    async () => {
      signal.throwIfAborted();
      await exec("systemctl", ["--user", "show-environment"]);
      if (await active())
        throw new Error(
          `Preview is already running. Use npm run preview:status or npm run preview:stop (${unit}).`,
        );
      signal.throwIfAborted();
      const { output } = await build({ target: "preview", signal });
      signal.throwIfAborted();
      const token = randomUUID();
      const directory = join(root, ".tmp/previews", token);
      await mkdir(directory, { recursive: true });
      const readyFile = join(directory, "ready.json");
      try {
        signal.throwIfAborted();
        await exec("systemd-run", [
          "--user",
          "--collect",
          `--unit=${unit}`,
          `--working-directory=${root}`,
          `--setenv=RACCO_PREVIEW_TOKEN=${token}`,
          "--property=KillMode=control-group",
          "--property=TimeoutStopSec=15s",
          process.execPath,
          "--import",
          "tsx",
          "test/fixtures/server.ts",
          "--directory",
          directory,
          "--build-info",
          join(output, "build-info.json"),
          "--web-root",
          join(output, "web"),
          "--ready-file",
          readyFile,
          "--token",
          token,
        ]);
        for (let attempt = 0; attempt < 100; attempt++) {
          signal.throwIfAborted();
          const info = await readFile(readyFile, "utf8")
            .then(JSON.parse)
            .catch((error) => {
              if (error.code === "ENOENT") return null;
              throw error;
            });
          if (info?.token === token && (await active())) {
            const result = {
              ...info,
              unit,
              mode: "fixture",
              buildDirectory: output,
            };
            await writeFile(
              infoPath + ".tmp",
              JSON.stringify(result, null, 2) + "\n",
            );
            await rename(infoPath + ".tmp", infoPath);
            signal.throwIfAborted();
            return result;
          }
          await delay(200, undefined, { signal });
        }
        const { stdout } = await exec("journalctl", [
          "--user",
          "-u",
          unit,
          "-n",
          "30",
          "--no-pager",
        ]);
        throw new Error(`Preview did not become ready:\n${stdout}`);
      } catch (error) {
        await stopOwned(token);
        await rm(directory, { recursive: true, force: true });
        if ((await receipt())?.token === token)
          await rm(infoPath, { force: true });
        throw error;
      }
    },
    signal,
  );
}
export async function previewStatus() {
  if (!(await active())) throw new Error(`Preview is not running (${unit}).`);
  const info = await receipt();
  if (!info || (await unitToken()) !== info.token)
    throw new Error("Preview ownership does not match its receipt");
  const response = await fetch(info.url + "/api/diagnostics", {
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok)
    throw new Error(`Preview diagnostics failed: ${response.status}`);
  const diagnostics = await response.json();
  if (diagnostics.process.pid !== info.pid)
    throw new Error("Preview process does not match its receipt");
  return { ...info, diagnostics };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cancellation = cancellationSignals();
  try {
    const action = process.argv[2] ?? "start";
    if (action === "start")
      console.log(
        JSON.stringify(
          await startPreview({ signal: cancellation.signal }),
          null,
          2,
        ),
      );
    else if (action === "status")
      console.log(JSON.stringify(await previewStatus(), null, 2));
    else if (action === "stop")
      console.log(JSON.stringify(await stopPreview()));
    else throw new Error("Use preview.mjs start|status|stop");
  } catch (error) {
    if (!cancellation.signal.aborted) throw error;
  } finally {
    cancellation.dispose();
  }
}
