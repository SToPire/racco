import { loadConfig } from "../src/server/config.ts";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { promisify, parseArgs } from "node:util";
import { buildInfo } from "./lib/build-info.mjs";
import { root } from "./lib/process.mjs";
const exec = promisify(execFile);
const { values } = parseArgs({
  options: {
    url: { type: "string" },
    config: { type: "string" },
    json: { type: "boolean", default: false },
  },
});
const checks = [];
const add = (name, ok, details) => checks.push({ name, ok, details });
let config;
if (!values.url || values.config) {
  try {
    config = await loadConfig(
      values.config ? resolve(values.config) : join(root, "racco.config.json"),
    );
    add("config", true, config);
  } catch (error) {
    add("config", false, error.message);
  }
}
const url =
  values.url ?? (config ? `http://${config.host}:${config.port}` : undefined);
add("node", Number(process.versions.node.split(".")[0]) >= 26, process.version);
try {
  await exec("systemctl", ["--user", "show-environment"]);
  add("systemd-user", true, "available");
} catch (error) {
  add("systemd-user", false, error.message);
}
// Worktree management reads `git worktree list`, so a missing git degrades the
// project tree to primary-worktree-only rows with a visible error.
try {
  const { stdout } = await exec("git", ["--version"]);
  add("git", true, stdout.trim());
} catch (error) {
  add("git", false, error.message);
}
let source;
try {
  source = await buildInfo();
  add("source", true, {
    revision: source.sourceRevision,
    digest: source.sourceDigest,
    dirty: source.dirty,
  });
} catch (error) {
  add("source", false, error.message);
}
if (!values.url) {
  try {
    const build = JSON.parse(
      await readFile(join(root, "dist/build-info.json"), "utf8"),
    );
    add(
      "build",
      build.schema === 1 && build.sourceDigest === source?.sourceDigest,
      build,
    );
  } catch (error) {
    add("build", false, `Run npm run build: ${error.message}`);
  }
}
if (url) {
  try {
    const response = await fetch(url.replace(/\/$/, "") + "/api/diagnostics", {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const runtime = await response.json();
    const current =
      runtime?.build?.schema === 1 &&
      Number.isInteger(runtime?.process?.pid) &&
      typeof runtime?.storage?.stateDir === "string";
    add("daemon", current, { url, ...runtime });
    if (config)
      add("state-directory", runtime.storage?.stateDir === config.stateDir, {
        configured: config.stateDir,
        running: runtime.storage?.stateDir,
      });
    add(
      "running-source",
      runtime.build?.sourceDigest === source?.sourceDigest,
      { built: runtime.build?.sourceDigest, current: source?.sourceDigest },
    );
    for (const provider of ["codex", "claude"]) {
      const state = runtime.providers?.[provider];
      add(
        `provider-${provider}`,
        state?.status === "ready",
        state ?? { error: "Provider diagnostic is missing" },
      );
    }
  } catch (error) {
    add("daemon", false, { url, error: error.message });
  }
} else
  add("daemon", false, {
    error: "Cannot determine daemon URL from invalid configuration",
  });
const report = {
  ok: checks.every((check) => check.ok),
  root: resolve(root),
  checks,
};
if (values.json) console.log(JSON.stringify(report, null, 2));
else
  for (const check of checks)
    console.log(
      `${check.ok ? "PASS" : "FAIL"} ${check.name}: ${JSON.stringify(check.details)}`,
    );
if (!report.ok) process.exitCode = 1;
