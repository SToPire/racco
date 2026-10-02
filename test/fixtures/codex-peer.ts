import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

/** A real stdio peer: each test declares its RPC handlers, unknown methods fail. */
export async function installFakeCodex(
  t: TestContext,
  { script }: { script: string },
) {
  const directory = await mkdtemp(join(tmpdir(), "racco-codex-peer-"));
  const previousPath = process.env.PATH;
  const requestsFile = join(directory, "requests.jsonl");
  process.env.PATH = `${directory}:${previousPath ?? ""}`;
  t.after(async () => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(join(directory, "handlers.mjs"), script);
  await writeFile(
    join(directory, "codex"),
    `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const { createInterface } = require('node:readline');
const { pathToFileURL } = require('node:url');
(async () => {
  const { handlers, onNotification } = await import(pathToFileURL(${JSON.stringify(join(directory, "handlers.mjs"))}));
  const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
  const lines = createInterface({ input: process.stdin });
  lines.on('line', async line => {
    const request = JSON.parse(line);
    appendFileSync(${JSON.stringify(requestsFile)}, line + '\\n');
    if (request.id === undefined) {
      await onNotification?.(request, { send });
      return;
    }
    const handler = handlers[request.method];
    if (typeof handler !== 'function') {
      send({ id: request.id, error: { code: -32601, message: 'Unexpected fixture RPC: ' + request.method } });
      return;
    }
    const after = [];
    try {
      const result = await handler(request.params, {
        send,
        notify: (method, params) => send({ method, params }),
        afterReply: callback => after.push(callback),
        request,
      });
      send({ id: request.id, result: result ?? {} });
      for (const callback of after) await callback();
    } catch (error) {
      send({ id: request.id, error: { code: -32603, message: error.message } });
    }
  });
})();
`,
    { mode: 0o700 },
  );
  return {
    directory,
    requestsFile,
    async requests(): Promise<Array<{ method: string; params: any }>> {
      const content = await readFile(requestsFile, "utf8").catch((error) => {
        if (error.code === "ENOENT") return "";
        throw error;
      });
      return content
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    },
  };
}
