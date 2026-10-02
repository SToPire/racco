import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { root } from "./lib/process.mjs";
import {
  executable,
  renderService,
  servicePath,
} from "./lib/service-environment.mjs";

const exec = promisify(execFile);
if (Number(process.versions.node.split(".")[0]) < 26)
  throw new Error("Install with Node 26 or newer");
await exec("systemctl", ["--user", "show-environment"]);
const path = servicePath(
  process.execPath,
  process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
);
for (const command of ["codex", "git", "flock"])
  await executable(command, path);
const { stdout } = await exec("systemctl", [
  "--user",
  "show",
  "raccod.service",
  "--property=ActiveState",
  "--value",
]);
if (!["inactive", "failed", ""].includes(stdout.trim()))
  throw new Error(
    "Stop raccod.service before installing: systemctl --user stop raccod.service",
  );
const entry = join(homedir(), ".local/share/racco");
const current = await lstat(entry).catch((error) => {
  if (error.code === "ENOENT") return null;
  throw error;
});
if (current && !current.isSymbolicLink())
  throw new Error(
    `${entry} exists and is not an installation symlink; leaving it unchanged`,
  );
await mkdir(dirname(entry), { recursive: true });
if (
  current &&
  (await realpath(entry).catch(() => null)) !== (await realpath(root))
)
  await rm(entry);
if (
  !current ||
  (await realpath(entry).catch(() => null)) !== (await realpath(root))
)
  await symlink(await realpath(root), entry);
const destination = join(
  process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
  "systemd/user/raccod.service",
);
await mkdir(dirname(destination), { recursive: true });
const template = await readFile(join(root, "systemd/raccod.service"), "utf8");
await writeFile(destination, renderService(template, process.execPath, path), {
  mode: 0o600,
});
await exec("systemctl", ["--user", "daemon-reload"]);
console.log(
  JSON.stringify({
    unit: destination,
    node: process.execPath,
    path,
    next: "npm run build && systemctl --user enable --now raccod.service",
  }),
);
