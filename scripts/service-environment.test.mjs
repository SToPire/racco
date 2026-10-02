import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  checkServiceEnvironment,
  parseService,
  renderService,
  servicePath,
  executable,
} from "./lib/service-environment.mjs";

test("service diagnostics check the configured Node and CLI PATH, not the shell runtime", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "racco-service-env-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const node = join(directory, "old-node");
  const shellBin = join(directory, "shell-bin");
  await mkdir(shellBin);
  await writeFile(join(shellBin, "codex"), '#!/bin/sh\nprintf "codex 1\\n"\n', {
    mode: 0o700,
  });
  assert.equal(await executable("codex", shellBin), join(shellBin, "codex"));
  await writeFile(node, '#!/bin/sh\nprintf "v22.0.0\\n"\n', { mode: 0o700 });
  const config = parseService(
    `LoadState=loaded\nExecStart={ path=${node} ; argv[]=${node} app.js ; }\nEnvironment=NODE_ENV=production "PATH=${directory}"\nMainPID=0\n`,
  );
  const checks = await checkServiceEnvironment(config);
  assert.equal(checks.find((check) => check.name === "service-node").ok, false);
  assert.match(
    checks.find((check) => check.name === "service-codex").details,
    /not executable in the service PATH/,
  );
  assert.equal(Number(process.versions.node.split(".")[0]) >= 26, true);
  await writeFile(
    join(directory, "codex"),
    '#!/bin/sh\nprintf "codex 1\\n"\n',
    { mode: 0o700 },
  );
  const repaired = await checkServiceEnvironment({
    ...config,
    node: process.execPath,
  });
  assert.equal(
    repaired.find((check) => check.name === "service-node").ok,
    true,
  );
  assert.equal(
    repaired.find((check) => check.name === "service-codex").ok,
    true,
  );
});

test("installation renders a pinned Node and explicit PATH rather than /usr/bin/node", async () => {
  const template = await readFile(
    new URL("../systemd/raccod.service", import.meta.url),
    "utf8",
  );
  const path = servicePath("/opt/node bin/node", "/opt/codex:/usr/bin");
  const unit = renderService(template, "/opt/node bin/node", path);
  assert.match(unit, /ExecStart="\/opt\/node bin\/node"/);
  assert.match(
    unit,
    /Environment="PATH=\/opt\/node bin:\/opt\/codex:\/usr\/bin"/,
  );
  assert.doesNotMatch(unit, /@NODE@|@PATH@/);
});
