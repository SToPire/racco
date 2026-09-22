import { mkdir, writeFile, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { buildServer } from "../../src/server/server.js";
import { readBuildInfo } from "../../src/server/runtime/build-info.js";
import type { BuildInfo } from "../../src/server/runtime/build-info.js";
import { FixtureDriver } from "./driver.js";
import { runGit } from "../../src/server/worktrees/git.js";

export async function startFixture(options: {
  directory: string;
  build: BuildInfo;
  webRoot?: string;
  port?: number;
}) {
  const directory = resolve(options.directory);
  const alpha = join(directory, "projects", "alpha");
  const beta = join(directory, "projects", "beta");
  await Promise.all([
    mkdir(join(alpha, "src"), { recursive: true }),
    mkdir(beta, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      join(alpha, "README.md"),
      "# Fixture project\n\nInline `code` and 中文.\n",
    ),
    writeFile(join(alpha, "src", "index.ts"), "export const answer = 42;\n"),
    writeFile(join(alpha, ".hidden"), "hidden fixture\n"),
    writeFile(
      join(alpha, "unsafe.html"),
      "<script>window.previewExecuted=true</script>",
    ),
    writeFile(join(alpha, "binary.bin"), Buffer.from([0, 1, 2])),
    writeFile(join(beta, "other.txt"), "Project beta\n"),
  ]);
  // Each project is a separate repository even when fixtures live under the
  // source checkout. This also exercises real Git worktrees in browser tests.
  await Promise.all(
    [alpha, beta].map(async (cwd) => {
      await runGit(["init", "-q"], { cwd });
      await runGit(["config", "user.email", "fixture@example.com"], { cwd });
      await runGit(["config", "user.name", "Fixture"], { cwd });
      await runGit(["add", "-A"], { cwd });
      await runGit(
        ["-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture"],
        { cwd },
      );
    }),
  );
  const drivers = [
    new FixtureDriver("codex", join(directory, "providers", "codex")),
    new FixtureDriver("claude", join(directory, "providers", "claude")),
  ];
  const app = await buildServer(
    {
      host: "127.0.0.1",
      port: options.port ?? 0,
      stateDir: join(directory, "state"),
      worktreeRoot: join(directory, "worktrees"),
    },
    {
      createDrivers: () => drivers,
      build: options.build,
      webRoot: options.webRoot,
      logger: false,
    },
  );
  for (const driver of drivers)
    await driver.seed(
      `fixture-${driver.provider}`,
      `[Fixture] ${driver.provider}`,
      driver.provider === "codex" ? alpha : beta,
    );
  for (const driver of drivers) {
    await driver.seed(
      `native-${driver.provider}-alpha`,
      `${driver.provider} Alpha history`,
      alpha,
    );
    await driver.seed(
      `native-${driver.provider}-beta`,
      `${driver.provider} Beta history`,
      beta,
    );
  }
  const projects = [];
  const sessions = [];
  for (const [index, path] of [alpha, beta].entries()) {
    const imported = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { path },
    });
    if (imported.statusCode !== 200) throw new Error(imported.body);
    const project = imported.json();
    projects.push(project);
    const provider = index === 0 ? "codex" : "claude";
    const session = await app.inject({
      method: "POST",
      url: "/api/sessions/import",
      payload: {
        projectId: project.projectId,
        provider,
        providerSessionId: `fixture-${provider}`,
        path: project.path,
      },
    });
    if (session.statusCode !== 200) throw new Error(session.body);
    sessions.push(session.json());
  }
  await app.listen({ host: "127.0.0.1", port: options.port ?? 0 });
  const address = app.server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing fixture server address");
  return {
    app,
    url: `http://127.0.0.1:${address.port}`,
    projects,
    sessions,
    directory,
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { values } = parseArgs({
    options: {
      directory: { type: "string" },
      "web-root": { type: "string" },
      "build-info": { type: "string" },
      "ready-file": { type: "string" },
      port: { type: "string", default: "0" },
      token: { type: "string" },
    },
  });
  if (
    !values.directory ||
    !values["build-info"] ||
    !values["ready-file"] ||
    !values.token
  )
    throw new Error(
      "Fixture server requires explicit directory, build-info, ready-file and token",
    );
  const fixture = await startFixture({
    directory: values.directory,
    build: await readBuildInfo(values["build-info"]),
    webRoot: values["web-root"],
    port: Number(values.port),
  });
  const info = {
    token: values.token,
    pid: process.pid,
    url: fixture.url,
    directory: fixture.directory,
    projects: fixture.projects,
    sessions: fixture.sessions,
  };
  const ready = values["ready-file"];
  await mkdir(join(ready, ".."), { recursive: true });
  await writeFile(ready + ".tmp", JSON.stringify(info, null, 2) + "\n");
  await rename(ready + ".tmp", ready);
  console.log(JSON.stringify({ type: "fixture.ready", ...info }));
  process.once("SIGTERM", () => void fixture.app.close());
  process.once("SIGINT", () => void fixture.app.close());
}
