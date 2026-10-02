import { execFile } from "node:child_process";
import { access, readFile, readlink, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
export function servicePath(node, path) {
  return [
    ...new Set([
      dirname(node),
      ...path.split(":").map((item) => resolve(item || ".")),
    ]),
  ].join(":");
}
export async function executable(command, path) {
  for (const directory of path.split(":")) {
    const candidate = join(directory, command);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* next PATH entry */
    }
  }
  throw new Error(`${command} is not executable in the service PATH (${path})`);
}
export function renderService(template, node, path) {
  const quote = (value) => JSON.stringify(value.replaceAll("%", "%%"));
  return template
    .replace("@NODE@", quote(node.replaceAll("$", "$$")))
    .replace("@PATH@", quote(`PATH=${path}`));
}
export function parseService(properties) {
  const values = Object.fromEntries(
    properties
      .trim()
      .split("\n")
      .map((line) => {
        const split = line.indexOf("=");
        return [line.slice(0, split), line.slice(split + 1)];
      }),
  );
  if (values.LoadState !== "loaded")
    throw new Error(
      "raccod.service is not installed; run npm run install:service",
    );
  const node = /\bpath=(.*?) ;/.exec(values.ExecStart ?? "")?.[1];
  const words =
    (values.Environment ?? "").match(/"(?:\\.|[^"\\])*"|\S+/g) ?? [];
  const environment = words.map((word) =>
    word.startsWith('"') ? JSON.parse(word) : word,
  );
  const path = environment.find((word) => word.startsWith("PATH="))?.slice(5);
  if (!node || !path)
    throw new Error(
      "Installed service has no explicit Node/PATH; run npm run install:service",
    );
  return {
    node: node.replace(/\\x([a-f\d]{2})/gi, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16)),
    ),
    path,
    pid: Number(values.MainPID ?? 0),
  };
}
export async function checkServiceEnvironment(config) {
  const checks = [];
  for (const [name, command] of [
    ["node", config.node],
    ["codex", "codex"],
    ["git", "git"],
    ["flock", "flock"],
  ]) {
    try {
      const binary =
        name === "node" ? command : await executable(command, config.path);
      const { stdout } = await exec(binary, ["--version"], {
        env: { ...process.env, PATH: config.path },
        timeout: 5000,
      });
      const version = stdout.trim();
      checks.push({
        name: `service-${name}`,
        ok: name !== "node" || Number(/^v?(\d+)/.exec(version)?.[1]) >= 26,
        details: { binary, version, path: config.path },
      });
    } catch (error) {
      checks.push({
        name: `service-${name}`,
        ok: false,
        details: error.message,
      });
    }
  }
  if (config.pid > 0) {
    const [node, environment] = await Promise.all([
      readlink(`/proc/${config.pid}/exe`),
      readFile(`/proc/${config.pid}/environ`),
    ]);
    const path = environment
      .toString()
      .split("\0")
      .find((entry) => entry.startsWith("PATH="))
      ?.slice(5);
    checks.push({
      name: "service-running-environment",
      ok: node === (await realpath(config.node)) && path === config.path,
      details: {
        pid: config.pid,
        node,
        path,
        configuredNode: config.node,
      },
    });
  }
  return checks;
}
