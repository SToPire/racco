import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
const execute = promisify(execFile);

test("check reporter counts cases including an intentional skip", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "racco-test-counts-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = join(directory, "cases.mjs");
  const report = join(directory, "counts.json");
  await writeFile(
    fixture,
    'import test from "node:test"; test("one",()=>{}); test.skip("two",()=>{});',
  );
  const environment = { ...process.env, RACCO_TEST_REPORT: report };
  delete environment.NODE_TEST_CONTEXT;
  await execute(
    process.execPath,
    [
      "--test",
      `--test-reporter=${resolve("scripts/lib/test-reporter.mjs")}`,
      fixture,
    ],
    { env: environment },
  );
  const counts = JSON.parse(await readFile(report, "utf8"));
  assert.equal(counts.tests, 2);
  assert.equal(counts.passed, 1);
  assert.equal(counts.skipped, 1);
});

test("full check rejects an accidentally focused browser test before launch", async (t) => {
  await mkdir(resolve(".tmp"), { recursive: true });
  const directory = await mkdtemp(resolve(".tmp/racco-focused-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    join(directory, "focused.spec.ts"),
    `import { test } from ${JSON.stringify(resolve("node_modules/@playwright/test/index.mjs"))}; test.only("accidental focus", () => {});`,
  );
  const config = join(directory, "playwright.config.ts");
  await writeFile(
    config,
    `import base from ${JSON.stringify(resolve("playwright.config.ts"))}; export default { ...base, testDir: ${JSON.stringify(directory)}, globalSetup: undefined, reporter: "list" };`,
  );
  const environment = { ...process.env, RACCO_FULL_CHECK: "1" };
  delete environment.NODE_TEST_CONTEXT;
  await assert.rejects(
    execute(
      process.execPath,
      [
        resolve("node_modules/@playwright/test/cli.js"),
        "test",
        "--config",
        config,
      ],
      { env: environment },
    ),
    (error) => {
      assert.match(error.stdout + error.stderr, /forbidOnly|test.only/);
      return true;
    },
  );
});
