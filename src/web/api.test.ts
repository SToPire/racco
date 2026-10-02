import assert from "node:assert/strict";
import test from "node:test";
import {
  getHealth,
  listProjects,
  listSessions,
  readWorktreeFile,
} from "./api.js";

test("REST responses are validated once before returning typed domain values", async (t) => {
  let value: unknown = {
    ok: true,
    providers: { codex: "ready", claude: "unavailable" },
  };
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(JSON.stringify(value), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  assert.deepEqual(await getHealth(), value);
  value = [{ projectId: "one", path: "/project", available: true }];
  await assert.rejects(listProjects(), /不符合当前协议/);
  value = { sessions: [] };
  await assert.rejects(listSessions(), /不符合当前协议/);
  value = {
    path: "readme",
    size: 1,
    modifiedAt: new Date().toISOString(),
    kind: "text",
    content: 1,
  };
  await assert.rejects(
    readWorktreeFile("/project", "readme"),
    /不符合当前协议/,
  );
});
