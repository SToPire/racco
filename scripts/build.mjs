import { parseArgs } from "node:util";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { root } from "./lib/process.mjs";
import { withFileLock } from "./lib/file-lock.mjs";
import { buildOutput } from "./lib/build-output.mjs";
import { cancellationSignals } from "./lib/signals.mjs";
export async function build({
  target = "production",
  part = "all",
  signal,
} = {}) {
  if (
    !["production", "check", "preview"].includes(target) ||
    !["all", "web", "server"].includes(part)
  )
    throw new Error("Invalid build target or part");
  if (target === "production" && part !== "all")
    throw new Error("Production builds must include both server and web");
  return withFileLock(
    join(root, ".tmp/locks", `build-${target}.lock`),
    () => buildOutput({ target, part, signal }),
    signal,
  );
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cancellation = cancellationSignals();
  try {
    const { values } = parseArgs({
      options: {
        target: { type: "string", default: "production" },
        part: { type: "string", default: "all" },
      },
    });
    await build({ ...values, signal: cancellation.signal });
  } catch (error) {
    if (!cancellation.signal.aborted) throw error;
  } finally {
    cancellation.dispose();
  }
}
