import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { root } from "./process.mjs";
export async function buildInfo() {
  const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const dirty =
    execFileSync("git", ["status", "--porcelain"], {
      cwd: root,
      encoding: "utf8",
    }).trim().length > 0;
  const names = execFileSync(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      "src",
      "assets/brand/racco/*.svg",
      "scripts",
      "test",
      "package.json",
      "package-lock.json",
      "index.html",
      "vite.config.ts",
      "playwright.config.ts",
      ".oxlintrc.json",
      "tsconfig*.json",
    ],
    { cwd: root, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);
  const hash = createHash("sha256");
  for (const name of [...new Set(names)].sort()) {
    const path = join(root, name);
    const info = await stat(path).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!info?.isFile()) continue;
    hash
      .update(name + "\0")
      .update(await readFile(path))
      .update("\0");
  }
  return {
    schema: 1,
    id: randomUUID(),
    sourceRevision,
    sourceDigest: hash.digest("hex"),
    dirty,
    builtAt: new Date().toISOString(),
  };
}
