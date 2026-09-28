import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../server.js";
import { TemporaryImages } from "./temporary.js";

const build = {
  schema: 1 as const,
  id: "test",
  sourceRevision: "test",
  sourceDigest: "test",
  dirty: false,
  builtAt: new Date().toISOString(),
};

test("startup cleans old images before constructing providers and an active state lock protects live images", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "racco-image-startup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = {
    host: "127.0.0.1",
    port: 0,
    stateDir: join(root, "state"),
    worktreeRoot: join(root, "worktrees"),
  };
  await mkdir(config.stateDir);
  const previous = await TemporaryImages.open(config.stateDir, { warn() {} });
  const original = await previous.create([
    { type: "image", mediaType: "image/png", data: "b2xk" },
  ]);
  await previous.close();
  let images!: TemporaryImages;
  const app = await buildServer(config, {
    build,
    logger: false,
    createDrivers: (_log, store) => {
      images = store;
      return [];
    },
  });
  try {
    assert.deepEqual(await readdir(images.directory), []);
    await assert.rejects(readFile(original.paths[0]), { code: "ENOENT" });
    const live = await images.create([
      { type: "image", mediaType: "image/png", data: "bGl2ZQ==" },
    ]);
    await assert.rejects(
      buildServer(config, {
        build,
        logger: false,
        createDrivers: () => {
          throw new Error("Must not construct providers");
        },
      }),
      /Another Racco process/,
    );
    assert.equal(await readFile(live.paths[0], "utf8"), "live");
    await live.dispose();
  } finally {
    await app.close();
  }
});

test("shutdown holds the state lock until image resource cleanup has finished", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "racco-image-shutdown-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = {
    host: "127.0.0.1",
    port: 0,
    stateDir: join(root, "state"),
    worktreeRoot: join(root, "worktrees"),
  };
  let entered!: () => void, release!: () => void;
  const reachedCleanup = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const app = await buildServer(config, {
    build,
    logger: false,
    createDrivers: (_log, images) => {
      const close = images.close.bind(images);
      images.close = async () => {
        entered();
        await gate;
        await close();
      };
      return [];
    },
  });
  const closing = app.close();
  let unexpected: Awaited<ReturnType<typeof buildServer>> | undefined;
  try {
    await reachedCleanup;
    await assert.rejects(
      buildServer(config, {
        build,
        logger: false,
        createDrivers: () => [],
      }).then((value) => {
        unexpected = value;
        return value;
      }),
      /Another Racco process/,
    );
  } finally {
    release();
    await closing;
    await unexpected?.close();
  }
  const next = await buildServer(config, {
    build,
    logger: false,
    createDrivers: () => [],
  });
  await next.close();
});

test("an image close error still releases the state lock after cleanup has settled", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "racco-image-close-error-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = {
    host: "127.0.0.1",
    port: 0,
    stateDir: join(root, "state"),
    worktreeRoot: join(root, "worktrees"),
  };
  const app = await buildServer(config, {
    build,
    logger: false,
    createDrivers: (_log, images) => {
      const close = images.close.bind(images);
      images.close = async () => {
        await close();
        throw new Error("image cleanup failure");
      };
      return [];
    },
  });
  await assert.rejects(app.close(), /image cleanup failure/);
  const next = await buildServer(config, {
    build,
    logger: false,
    createDrivers: () => [],
  });
  await next.close();
});
