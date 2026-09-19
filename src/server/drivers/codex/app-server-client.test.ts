import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexAppServerClient } from "./app-server-client.js";

test(
  "fails pending requests and stops the provider on invalid RPC output",
  { timeout: 10_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "racco-rpc-test-"));
    const previousExecutablePath = process.env.PATH;
    assert(previousExecutablePath !== undefined);
    process.env.PATH = `${directory}:${previousExecutablePath}`;
    t.after(async () => {
      process.env.PATH = previousExecutablePath;
      await rm(directory, { recursive: true, force: true });
    });

    for (const output of [
      "not-json",
      "[]",
      '{"unexpected":true}',
      '{"id":"question","method":"item/tool/requestUserInput"}\nnot-json',
    ]) {
      await writeFile(
        join(directory, "codex"),
        `#!/usr/bin/env node
process.stdin.once("data", () => process.stdout.write(${JSON.stringify(output + "\n")}));
setInterval(() => {}, 1000);
`,
        { mode: 0o700 },
      );
      const exits: Error[] = [];
      let rejectInteraction: ((error: Error) => void) | undefined;
      const client = new CodexAppServerClient(
        { info() {}, warn() {} },
        () =>
          new Promise((_resolve, reject) => {
            rejectInteraction = reject;
          }),
      );
      client.onExit((error) => exits.push(error));
      try {
        await assert.rejects(client.start(), /Invalid Codex app-server/);
        assert.equal(exits.length, 1);
        await assert.rejects(
          client.request("thread/read", {}),
          /has not started/,
        );
        rejectInteraction?.(new Error("Provider exited"));
        await new Promise<void>((resolve) => setImmediate(resolve));
      } finally {
        await client.close();
      }
    }
  },
);
