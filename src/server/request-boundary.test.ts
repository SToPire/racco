import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { DEFAULT_ALLOWED_HOSTS, hasTrustedSource } from "./request-boundary.js";
import { buildServer } from "./server.js";

test("trusted Host is independent of Origin and forwarded headers never expand it", () => {
  const hosts = new Set([
    ...DEFAULT_ALLOWED_HOSTS,
    "racco.example",
    "100.64.0.1",
  ]);
  for (const [host, origin] of [
    ["localhost:54321", "http://localhost:54321"],
    ["127.0.0.1:7331", undefined],
    ["[::1]:7331", "http://[::1]:7331"],
    ["100.64.0.1:7331", "http://100.64.0.1:7331"],
    ["racco.example", "https://racco.example"],
    ["localhost:80", "http://localhost"],
  ])
    assert.equal(
      hasTrustedSource({ host, origin }, hosts),
      true,
      `${host} ${origin}`,
    );
  for (const headers of [
    { host: "unknown.example:7331", origin: "http://unknown.example:7331" },
    {
      host: "unknown.example",
      "x-forwarded-host": "localhost",
      forwarded: "host=localhost",
    },
    { host: "localhost:7331", origin: "http://evil.example" },
    { host: "localhost:7331", origin: "http://localhost:8888" },
    { host: "localhost", origin: "null" },
    { host: "localhost", origin: "file://localhost" },
    { host: "localhost", origin: "http://localhost/path" },
    { host: "localhost", origin: "http://user@localhost" },
    { host: "localhost", "sec-fetch-site": "cross-site" },
    { host: "localhost@evil.example" },
    { host: "localhost/path" },
    {},
  ])
    assert.equal(
      hasTrustedSource(headers, hosts),
      false,
      JSON.stringify(headers),
    );
});

test(
  "the server applies the same boundary to reads, writes, directories and real WebSocket upgrades",
  { timeout: 15_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "racco-request-boundary-"));
    const app = await buildServer(
      {
        host: "127.0.0.1",
        port: 0,
        allowedHosts: [...DEFAULT_ALLOWED_HOSTS, "racco.example", "100.64.0.1"],
        stateDir: join(directory, "state"),
        worktreeRoot: join(directory, "worktrees"),
      },
      {
        logger: false,
        createDrivers: () => [],
        build: {
          schema: 1,
          id: "test",
          sourceRevision: "test",
          sourceDigest: "test",
          dirty: false,
          builtAt: "2026-10-02T00:00:00.000Z",
        },
      },
    );
    const clients: WebSocket[] = [];
    t.after(async () => {
      for (const client of clients) client.terminate();
      await app.close();
      await rm(directory, { recursive: true, force: true });
    });
    for (const [method, url] of [
      ["GET", "/api/health"],
      ["GET", "/api/diagnostics"],
      ["GET", "/api/projects"],
      ["POST", "/api/projects"],
      ["GET", "/api/directories"],
      ["GET", "/api/worktrees/file"],
      ["GET", "/api/ws"],
    ] as const) {
      const response = await app.inject({
        method,
        url,
        headers: { host: "unknown.example", origin: "http://unknown.example" },
      });
      assert.equal(response.statusCode, 403, `${method} ${url}`);
    }
    for (const headers of [
      { host: "localhost:43210", origin: "http://localhost:43210" },
      {
        host: "racco.example",
        origin: "https://racco.example",
        "x-forwarded-host": "ignored.example",
      },
      { host: "100.64.0.1:7331", origin: "http://100.64.0.1:7331" },
    ])
      assert.equal(
        (await app.inject({ method: "GET", url: "/api/health", headers }))
          .statusCode,
        200,
      );
    const rejectedImport = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { host: "localhost", origin: "https://evil.example" },
      payload: { path: directory },
    });
    assert.equal(rejectedImport.statusCode, 403);
    assert.deepEqual(
      (await app.inject({ method: "GET", url: "/api/projects" })).json(),
      [],
    );

    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const denied = new WebSocket(`${address.replace("http:", "ws:")}/api/ws`, {
      headers: { host: "unknown.example", origin: "http://unknown.example" },
    });
    clients.push(denied);
    denied.on("error", () => {});
    const [, response] = await once(denied, "unexpected-response");
    assert.equal(response.statusCode, 403);
    response.resume();
    denied.terminate();

    const accepted = new WebSocket(
      `${address.replace("http:", "ws:")}/api/ws`,
      { headers: { host: "racco.example", origin: "https://racco.example" } },
    );
    clients.push(accepted);
    await once(accepted, "open");
    assert.equal(accepted.readyState, WebSocket.OPEN);
    const closed = once(accepted, "close");
    accepted.close();
    await closed;
  },
);
