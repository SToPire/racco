import { rename, rm } from "node:fs/promises";
/** Publish a complete directory; retain the previous output if promotion fails. */
export async function publishBuild(stage, output) {
  const backup = stage + "-previous";
  let previous = false;
  try {
    await rename(output, backup);
    previous = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    await rename(stage, output);
  } catch (error) {
    if (previous) await rename(backup, output);
    throw error;
  }
  if (previous) await rm(backup, { recursive: true, force: true });
}
