import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  query,
  startup,
  type ListSessionsOptions,
} from "@anthropic-ai/claude-agent-sdk";
import { ClaudeDriver } from "./claude-driver.js";

test("Claude discovers only the chosen directory, paginates and rejects invalid offsets without a query", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "racco-claude-discovery-"));
  const cwd = join(directory, "project");
  await mkdir(cwd);
  const calls: Array<ListSessionsOptions | undefined> = [];
  const driver = new ClaudeDriver(
    { warn() {} },
    {
      startup: (async () => ({ close() {} })) as unknown as typeof startup,
      query: (() => {
        throw new Error("Discovery must not execute a query");
      }) as typeof query,
      async listSessions(options) {
        calls.push(options);
        return options?.offset
          ? []
          : Array.from({ length: 51 }, (_, index) => ({
              sessionId: String(index),
              cwd: index === 1 ? directory : cwd,
              summary: "Summary",
              customTitle: index === 0 ? "Renamed" : undefined,
              lastModified: 1700000000000,
            }));
      },
      async deleteSession() {
        throw new Error("deleteSession not expected");
      },
    },
  );
  t.after(async () => {
    await driver.close();
    await rm(directory, { recursive: true, force: true });
  });
  await driver.start();
  const signal = new AbortController().signal;
  const page = await driver.listSessions({ cwd, signal });
  assert.equal(page.sessions.length, 49);
  assert.equal(page.sessions[0].title, "Renamed");
  assert.equal(page.nextCursor, "50");
  assert.deepEqual(calls[0], {
    dir: cwd,
    includeWorktrees: false,
    includeProgrammatic: true,
    limit: 51,
    offset: 0,
  });
  assert.equal(
    (await driver.listSessions({ cwd, signal, cursor: "50" })).nextCursor,
    null,
  );
  assert.equal(calls[1]?.offset, 50);
  for (const cursor of ["-1", "NaN", "1e3", "9007199254740991"])
    await assert.rejects(
      driver.listSessions({ cwd, signal, cursor }),
      /Invalid Claude session cursor/,
    );
  assert.equal(calls.length, 2);
});
