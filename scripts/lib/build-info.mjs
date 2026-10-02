import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { root } from "./process.mjs";

const buildFiles = new Set([
  "package.json",
  "package-lock.json",
  "index.html",
  "vite.config.ts",
  "tsconfig.json",
  "tsconfig.server.json",
  "scripts/build.mjs",
  "scripts/lib/build-output.mjs",
  "scripts/lib/build-info.mjs",
]);
function artifactInput(name) {
  return (
    (name.startsWith("src/") && !/\.test\.[cm]?[jt]sx?$/.test(name)) ||
    /^assets\/brand\/racco\/[^/]+\.svg$/.test(name) ||
    buildFiles.has(name)
  );
}

async function metadata(directory, verification) {
  const git = (...args) =>
    execFileSync("git", args, { cwd: directory, encoding: "utf8" });
  const names = git(
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
  )
    .split("\0")
    .filter(Boolean);
  const artifactHash = createHash("sha256");
  const verificationHash = verification ? createHash("sha256") : undefined;
  for (const name of [...new Set(names)].sort()) {
    const artifact = artifactInput(name);
    if (!artifact && !verificationHash) continue;
    const path = join(directory, name);
    const info = await stat(path).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!info?.isFile()) continue;
    const content = await readFile(path);
    for (const hash of [artifact ? artifactHash : undefined, verificationHash])
      hash
        ?.update(name + "\0")
        .update(content)
        .update("\0");
  }
  return {
    schema: 1,
    id: randomUUID(),
    sourceRevision: git("rev-parse", "HEAD").trim(),
    sourceDigest: artifactHash.digest("hex"),
    dirty: git("status", "--porcelain").trim().length > 0,
    builtAt: new Date().toISOString(),
    ...(verificationHash
      ? { verificationDigest: verificationHash.digest("hex") }
      : {}),
  };
}

// Runtime build metadata has one strict schema; verification-only fields never
// enter the deployed build-info.json or the wire protocol.
export const buildInfo = (directory = root) => metadata(directory, false);
export const verificationInfo = (directory = root) => metadata(directory, true);
