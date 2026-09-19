import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

test("doctor emits JSON failure reports for invalid and missing configurations", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "racco-doctor-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const malformed = join(directory, "malformed.json");
  const invalid = join(directory, "invalid.json");
  await writeFile(malformed, "{broken");
  await writeFile(invalid, JSON.stringify({ port: -1 }));
  for (const config of [malformed, invalid, join(directory, "missing.json")]) {
    let failure;
    try {
      execFileSync(
        process.execPath,
        ["--import", "tsx", "scripts/doctor.mjs", "--json", "--config", config],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (error) {
      failure = error;
    }
    assert.equal(failure?.status, 1);
    const report = JSON.parse(failure.stdout);
    assert.equal(report.ok, false);
    assert.equal(
      report.checks.find((check) => check.name === "config")?.ok,
      false,
    );
    assert.equal(
      report.checks.find((check) => check.name === "daemon")?.ok,
      false,
    );
  }
});
