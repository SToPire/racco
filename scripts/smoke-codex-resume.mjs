import { build } from "./build.mjs";
import { isolatedServer } from "./lib/isolated-server.mjs";
import { cleanupSmokeSessions } from "./lib/smoke-target.mjs";
import { runResumeSmoke } from "./lib/resume-smoke.mjs";

if (
  process.env.RACCO_URL ||
  process.env.RACCO_SESSION_ID ||
  process.env.RACCO_TEST_CWD
)
  throw new Error(
    "Cold-resume smoke owns an isolated daemon and project; external targets and sessions are not accepted",
  );
const provider = process.env.RACCO_PROVIDER ?? "codex";
await build({ target: "check" });
const server = await isolatedServer();
let result;
try {
  result = await runResumeSmoke(server, provider);
} finally {
  try {
    if (server.baseUrl)
      await cleanupSmokeSessions(server.baseUrl, {
        provider: provider,
        cwd: server.cwd,
      });
  } finally {
    await server.close();
  }
}

console.log(
  `${provider} cold restart/native-memory smoke passed: ${JSON.stringify(result)}`,
);
