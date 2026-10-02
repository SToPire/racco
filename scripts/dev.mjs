import { createServer } from "vite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { cancellationSignals } from "./lib/signals.mjs";
import { buildInfo } from "./lib/build-info.mjs";

export async function startDevelopment({
  fixture = false,
  backend,
  signal,
} = {}) {
  if (fixture === Boolean(backend))
    throw new Error(
      "Choose --fixture or --backend http://host:port explicitly",
    );
  let application;
  let directory;
  let vite;
  const close = async () => {
    try {
      await vite?.close();
    } finally {
      try {
        await application?.app.close();
      } finally {
        if (directory) await rm(directory, { recursive: true, force: true });
      }
    }
  };
  try {
    signal?.throwIfAborted();
    if (fixture) {
      const { startFixture } = await import("../test/fixtures/server.ts");
      directory = await mkdtemp(join(tmpdir(), "racco-dev-"));
      application = await startFixture({ directory, build: await buildInfo() });
      backend = application.url;
    } else {
      const url = new URL(backend);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash
      )
        throw new Error(
          "Backend must be an HTTP(S) origin without credentials, path, query or fragment",
        );
      backend = url.origin;
    }
    signal?.throwIfAborted();
    vite = await createServer({
      server: {
        host: "127.0.0.1",
        port: 0,
        proxy: { "/api": { target: backend, ws: true } },
      },
    });
    await vite.listen();
    signal?.throwIfAborted();
    return {
      mode: fixture ? "fixture" : "backend",
      web: vite.resolvedUrls.local,
      backend,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const cancellation = cancellationSignals();
  let development;
  try {
    const { values } = parseArgs({
      options: { fixture: { type: "boolean" }, backend: { type: "string" } },
    });
    development = await startDevelopment({
      ...values,
      signal: cancellation.signal,
    });
    const { mode, web, backend } = development;
    console.log(JSON.stringify({ mode, web, backend }));
    await new Promise((done) =>
      cancellation.signal.aborted
        ? done()
        : cancellation.signal.addEventListener("abort", done, { once: true }),
    );
  } catch (error) {
    if (!cancellation.signal.aborted) throw error;
  } finally {
    try {
      await development?.close();
    } finally {
      cancellation.dispose();
    }
  }
}
