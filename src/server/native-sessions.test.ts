import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startFixture } from "../../test/fixtures/server.js";

test("native session discovery stays scoped and read-only; imports are explicit, idempotent and project-checked", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "racco-native-sessions-"));
  const fixture = await startFixture({
    directory,
    build: {
      schema: 1,
      id: "test",
      sourceRevision: "test",
      sourceDigest: "test",
      dirty: false,
      builtAt: new Date().toISOString(),
    },
  });
  t.after(async () => {
    await fixture.app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const { app, projects, sessions } = fixture;
  const url = `/api/projects/${projects[0].projectId}/native-sessions`;
  const listed = await app.inject(`${url}?provider=codex`);
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.headers["cache-control"], "no-store");
  assert.deepEqual(
    new Set(
      listed
        .json()
        .sessions.map(
          (item: { providerSessionId: string }) => item.providerSessionId,
        ),
    ),
    new Set(["fixture-codex", "native-codex-alpha"]),
  );
  assert.equal(
    listed
      .json()
      .sessions.find(
        (item: { providerSessionId: string }) =>
          item.providerSessionId === "fixture-codex",
      ).managedSessionId,
    sessions[0].sessionId,
  );
  assert.equal((await app.inject("/api/sessions")).json().length, 2);
  assert.equal(
    (await app.inject(`${url}?provider=claude`)).json().sessions[0]
      .providerSessionId,
    "native-claude-alpha",
  );
  for (const query of [
    "",
    "?provider=bad",
    "?provider=codex&cwd=/",
    "?provider=codex&cursor=",
  ])
    assert.equal((await app.inject(url + query)).statusCode, 400);
  assert.equal(
    (await app.inject("/api/projects/missing/native-sessions?provider=codex"))
      .statusCode,
    404,
  );
  for (const headers of [
    { origin: "https://elsewhere.example" },
    { "sec-fetch-site": "cross-site" },
  ])
    assert.equal(
      (await app.inject({ url: `${url}?provider=codex`, headers })).statusCode,
      403,
    );
  const payload = {
    provider: "codex",
    providerSessionId: "native-codex-alpha",
    projectId: projects[0].projectId,
  };
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/sessions/import",
        payload: { ...payload, projectId: projects[1].projectId },
      })
    ).statusCode,
    400,
  );
  const imports = await Promise.all(
    [1, 2].map(() =>
      app.inject({ method: "POST", url: "/api/sessions/import", payload }),
    ),
  );
  assert.ok(imports.every((response) => response.statusCode === 200));
  assert.equal(imports[0].json().sessionId, imports[1].json().sessionId);
  assert.equal(imports[0].json().selectedModelSettings, null);
  assert.equal((await app.inject("/api/sessions")).json().length, 3);
  const updated = (await app.inject(`${url}?provider=codex`)).json();
  assert.equal(
    updated.sessions.find(
      (item: { providerSessionId: string }) =>
        item.providerSessionId === payload.providerSessionId,
    ).managedSessionId,
    imports[0].json().sessionId,
  );
});

test("native session delete removes provider files, managed records and rejects invalid requests", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "racco-native-delete-"));
  const fixture = await startFixture({
    directory,
    build: {
      schema: 1,
      id: "test",
      sourceRevision: "test",
      sourceDigest: "test",
      dirty: false,
      builtAt: new Date().toISOString(),
    },
  });
  t.after(async () => {
    await fixture.app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const { app, projects } = fixture;
  const url = `/api/sessions/delete-native`;
  const codexDir = join(directory, "providers", "codex");
  const claudeDir = join(directory, "providers", "claude");

  // Deleting an unmanaged native session removes only the provider file.
  const unmanaged = await app.inject({
    method: "POST",
    url,
    payload: {
      provider: "codex",
      providerSessionId: "native-codex-alpha",
      projectId: projects[0]!.projectId,
    },
  });
  assert.equal(unmanaged.statusCode, 200);
  assert.deepEqual(unmanaged.json(), { removedManagedSessionId: null });
  assert.equal(
    (await readdir(codexDir)).includes("native-codex-alpha.json"),
    false,
  );
  assert.equal((await app.inject("/api/sessions")).json().length, 2);

  // Deleting a managed native session removes the record and the file.
  const claudeSession = (
    await app.inject(
      `/api/projects/${projects[1]!.projectId}/native-sessions?provider=claude`,
    )
  )
    .json()
    .sessions.find(
      (item: { providerSessionId: string }) =>
        item.providerSessionId === "native-claude-beta",
    );
  const managed = await app.inject({
    method: "POST",
    url,
    payload: {
      provider: "claude",
      providerSessionId: "native-claude-beta",
      projectId: projects[1]!.projectId,
    },
  });
  assert.equal(managed.statusCode, 200);
  assert.equal(
    managed.json().removedManagedSessionId,
    claudeSession.managedSessionId,
  );
  assert.equal(
    (await readdir(claudeDir)).includes("native-claude-beta.json"),
    false,
  );
  assert.equal(
    (await app.inject("/api/sessions"))
      .json()
      .some(
        (session: { sessionId: string }) =>
          session.sessionId === claudeSession.managedSessionId,
      ),
    false,
  );

  // Cross-project management is refused before the provider file is touched.
  const foreign = await app.inject({
    method: "POST",
    url,
    payload: {
      provider: "codex",
      providerSessionId: "fixture-codex",
      projectId: projects[1]!.projectId,
    },
  });
  assert.equal(foreign.statusCode, 400);
  assert.match(foreign.json().message, /different project/);
  assert.equal((await readdir(codexDir)).includes("fixture-codex.json"), true);

  for (const headers of [
    { origin: "https://elsewhere.example" },
    { "sec-fetch-site": "cross-site" },
  ])
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url,
          headers,
          payload: {
            provider: "codex",
            providerSessionId: "fixture-codex",
            projectId: projects[0]!.projectId,
          },
        })
      ).statusCode,
      403,
    );
  for (const payload of [
    {},
    { provider: "bad", providerSessionId: "x", projectId: "y" },
    { provider: "codex", projectId: "y" },
    { provider: "codex", providerSessionId: "x", projectId: "y", extra: 1 },
  ])
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url,
          payload,
        })
      ).statusCode,
      400,
    );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url,
        payload: {
          provider: "codex",
          providerSessionId: "missing-native",
          projectId: projects[0]!.projectId,
        },
      })
    ).statusCode,
    400,
  );
});
