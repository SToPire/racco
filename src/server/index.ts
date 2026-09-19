import { fileURLToPath } from "node:url";
import { CodexDriver } from "./drivers/codex/codex-driver.js";
import { ClaudeDriver } from "./drivers/claude/claude-driver.js";
import { readBuildInfo } from "./runtime/build-info.js";
import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";

process.title = "raccod";

const config = await loadConfig();
const app = await buildServer(config, {
  createDrivers: (log) => [new CodexDriver(log), new ClaudeDriver(log)],
  build: await readBuildInfo(new URL("../build-info.json", import.meta.url)),
  webRoot: fileURLToPath(new URL("../web/", import.meta.url)),
});

await app.listen({ host: config.host, port: config.port });

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) {
    return;
  }
  closing = true;
  app.log.info({ signal }, "Stopping Racco");
  await app.close();
}

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});
