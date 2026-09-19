import { publishBuild } from "./publish-build.mjs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { run, root } from "./process.mjs";
import { buildInfo } from "./build-info.mjs";
export async function buildOutput({
  target = "production",
  part = "all",
  signal,
} = {}) {
  const outputs = {
    production: "dist",
    check: ".tmp/check-build",
    preview: ".tmp/preview-build",
  };
  if (
    !Object.hasOwn(outputs, target) ||
    !["all", "web", "server"].includes(part)
  )
    throw new Error("Invalid build target or part");
  if (target === "production" && part !== "all")
    throw new Error("Production builds must include both server and web");
  const out = join(root, outputs[target]);
  await mkdir(join(root, ".tmp"), { recursive: true });
  const stage = await mkdtemp(join(root, ".tmp/build-stage-"));
  try {
    const sourceBefore = await buildInfo();
    if (part !== "web")
      await run(
        process.execPath,
        [
          "node_modules/typescript/bin/tsc",
          "-p",
          "tsconfig.server.json",
          "--outDir",
          stage,
        ],
        { signal },
      );
    if (part !== "server")
      await run(
        process.execPath,
        [
          "node_modules/vite/bin/vite.js",
          "build",
          "--outDir",
          join(stage, "web"),
        ],
        { signal },
      );
    const info = await buildInfo();
    if (
      sourceBefore.sourceDigest !== info.sourceDigest ||
      sourceBefore.sourceRevision !== info.sourceRevision
    ) {
      throw new Error(
        "Source changed during the build; output was not published. Re-run after edits finish.",
      );
    }
    await writeFile(
      join(stage, "build-info.json"),
      JSON.stringify(info, null, 2) + "\n",
    );
    await mkdir(join(out, ".."), { recursive: true });
    signal?.throwIfAborted();
    await publishBuild(stage, out);
    console.log(
      JSON.stringify({ type: "build.complete", output: out, ...info }),
    );
    return { output: out, info };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
