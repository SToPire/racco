import { buildInfo } from "./lib/build-info.mjs";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { run, root } from "./lib/process.mjs";
const checks = [
  "check:notes",
  "lint",
  "format:check",
  "typecheck",
  "test",
  "test:tools",
  "build:check",
  "test:ui",
];
const source = await buildInfo();
const results = [];
let failed = false;
await mkdir(join(root, ".tmp/check"), { recursive: true });
for (const check of checks) {
  const startedAt = new Date().toISOString();
  try {
    await run("npm", ["run", check]);
    results.push({ check, startedAt, result: "passed" });
  } catch (error) {
    results.push({ check, startedAt, result: "failed", error: error.message });
    failed = true;
    break;
  }
}
const finishedSource = await buildInfo();
if (
  finishedSource.sourceDigest !== source.sourceDigest ||
  finishedSource.sourceRevision !== source.sourceRevision
) {
  failed = true;
  results.push({
    check: "source-stability",
    result: "failed",
    error: "Source changed during verification",
  });
}
const report = {
  source,
  ok: !failed,
  completedAt: new Date().toISOString(),
  checks: results,
};
await writeFile(
  join(root, ".tmp/check/report.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report));
if (failed) process.exitCode = 1;
