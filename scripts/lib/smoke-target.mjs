import { build } from "../build.mjs";
import { isolatedServer } from "./isolated-server.mjs";

/** Explicit targets are diagnostics; defaults own and clean their whole daemon. */
export async function withSmokeTarget(run) {
  if (process.env.RACCO_URL !== undefined) {
    if (!process.env.RACCO_TEST_CWD)
      throw new Error("Explicit RACCO_URL diagnostics require RACCO_TEST_CWD");
    console.log("Diagnostic target: caller owns daemon and session cleanup");
    return run({
      baseUrl: process.env.RACCO_URL,
      cwd: process.env.RACCO_TEST_CWD,
    });
  }
  if (process.env.RACCO_TEST_CWD)
    throw new Error(
      "RACCO_TEST_CWD requires explicit RACCO_URL; default smoke uses a temporary project",
    );
  await build({ target: "check" });
  const server = await isolatedServer();
  try {
    await server.start();
    return await run({ baseUrl: server.baseUrl, cwd: server.cwd });
  } finally {
    try {
      if (server.baseUrl)
        await cleanupSmokeSessions(server.baseUrl, {
          provider: process.env.RACCO_PROVIDER ?? "codex",
          cwd: server.cwd,
        });
    } finally {
      await server.close();
    }
  }
}

export async function cleanupSmokeSessions(baseUrl, { provider, cwd }) {
  const response = await fetch(`${baseUrl}/api/projects`);
  if (!response.ok)
    throw new Error(
      `Cannot list smoke projects for cleanup: ${response.status}`,
    );
  const project = (await response.json()).find(
    (project) => project.path === cwd,
  );
  if (!project) return;
  const targets = [{ provider, projectId: project.projectId, cwd }];
  const errors = [];
  for (const session of targets) {
    try {
      let cursor;
      const owned = [];
      const seen = new Set();
      do {
        const query = new URLSearchParams({
          provider: session.provider,
          path: session.cwd,
          ...(cursor ? { cursor } : {}),
        });
        const listing = await fetch(
          `${baseUrl}/api/worktrees/native-sessions?${query}`,
        );
        if (!listing.ok)
          throw new Error(
            `Native smoke session listing returned ${listing.status}`,
          );
        const page = await listing.json();
        owned.push(...page.sessions);
        cursor = page.nextCursor;
        if (cursor && seen.has(cursor))
          throw new Error("Repeated native session cursor during cleanup");
        if (cursor) seen.add(cursor);
      } while (cursor);
      // This path belongs exclusively to this smoke run, including native sessions
      // whose initial turn failed before a managed-session association was saved.
      for (const native of owned) {
        const removed = await fetch(`${baseUrl}/api/sessions/delete-native`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            provider: session.provider,
            providerSessionId: native.providerSessionId,
            projectId: session.projectId,
            path: session.cwd,
          }),
        });
        if (!removed.ok)
          throw new Error(
            `Native smoke session cleanup returned ${removed.status}: ${await removed.text()}`,
          );
      }
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length)
    throw new AggregateError(errors, "Failed to clean native smoke sessions");
}
