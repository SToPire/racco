import { rename, rm } from "node:fs/promises";
import { run } from "./process.mjs";

/** Deployment stops the reader before publication; failures require manual repair. */
export async function publishBuild(
  stage,
  output,
  { deploy = false, signal } = {},
) {
  signal?.throwIfAborted();
  if (deploy)
    await run("systemctl", ["--user", "stop", "raccod.service"], { signal });
  signal?.throwIfAborted();
  await rm(output, { recursive: true, force: true });
  await rename(stage, output);
  if (deploy)
    await run("systemctl", ["--user", "start", "raccod.service"], { signal });
}
