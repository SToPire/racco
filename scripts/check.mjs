import { buildInfo } from "./lib/build-info.mjs";
import { writeFile, mkdir, readFile, rm } from "node:fs/promises";
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
  "test:compiled",
  "test:ui",
];
const source = await buildInfo();
const results = [];
let failed = false;
await mkdir(join(root, ".tmp/check"), { recursive: true });
for (const check of checks) {
  const startedAt = new Date().toISOString();
  const nodeReport = ["test", "test:tools", "test:compiled"].includes(check)
    ? join(
        root,
        ".tmp/check",
        check === "test"
          ? "unit-counts.json"
          : check === "test:tools"
            ? "tool-counts.json"
            : "compiled-counts.json",
      )
    : undefined;
  const uiReport =
    check === "test:ui" ? join(root, ".tmp/check/playwright.json") : undefined;
  const reportPath = nodeReport ?? uiReport;
  if (reportPath) await rm(reportPath, { force: true });
  try {
    await run("npm", ["run", check], {
      env: {
        ...process.env,
        RACCO_FULL_CHECK: "1",
        ...(nodeReport ? { RACCO_TEST_REPORT: nodeReport } : {}),
      },
    });
    let counts;
    if (reportPath) {
      const report = JSON.parse(await readFile(reportPath, "utf8"));
      counts = nodeReport
        ? report
        : {
            tests:
              report.stats.expected +
              report.stats.unexpected +
              report.stats.flaky +
              report.stats.skipped,
            passed: report.stats.expected,
            failed: report.stats.unexpected,
            flaky: report.stats.flaky,
            skipped: report.stats.skipped,
          };
      if (!counts.tests)
        throw new Error("No executed or skipped test cases reported");
      console.log(`${check}: ${JSON.stringify(counts)}`);
    }
    results.push({
      check,
      startedAt,
      result: "passed",
      ...(counts ? { counts } : {}),
    });
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
