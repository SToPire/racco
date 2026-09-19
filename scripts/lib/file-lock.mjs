import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { run } from "./process.mjs";

/** flock shares the inherited open-file description; closing our descriptor releases it. */
export async function withFileLock(path, action, signal) {
  await mkdir(dirname(path), { recursive: true });
  const file = await open(path, "a+");
  try {
    await run("flock", ["--nonblock", "--conflict-exit-code", "75", "3"], {
      stdio: ["ignore", "inherit", "inherit", file.fd],
      signal,
    });
    signal?.throwIfAborted();
    return await action();
  } finally {
    await file.close();
  }
}
