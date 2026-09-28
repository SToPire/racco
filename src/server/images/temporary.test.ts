import assert from "node:assert/strict";
import test from "node:test";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { TemporaryImages } from "./temporary.js";
import type { UserInput } from "../../shared/user-input.js";
const content: UserInput = [
  {
    type: "image",
    mediaType: "image/png",
    data: Buffer.from("validated upstream").toString("base64"),
  },
];

test("temporary images are private, isolated by state directory and removed at startup", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "racco-temp-images-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const log = { warn() {} };
  await Promise.all([
    mkdir(join(root, "state-a")),
    mkdir(join(root, "state-b")),
  ]);
  const previous = await TemporaryImages.open(join(root, "state-a"), log, root);
  const other = await TemporaryImages.open(join(root, "state-b"), log, root);
  const old = await previous.create(content),
    untouched = await other.create(content);
  assert.equal((await lstat(old.paths[0])).mode & 0o777, 0o600);
  assert.equal((await lstat(dirname(old.paths[0]))).mode & 0o777, 0o700);
  await previous.close(); // Simulate leftovers from a dead service.
  const restarted = await TemporaryImages.open(
    join(root, "state-a"),
    log,
    root,
  );
  assert.deepEqual(await readdir(restarted.directory), []);
  assert.equal(
    (await readFile(untouched.paths[0])).toString(),
    "validated upstream",
  );
  const fresh = await restarted.create(content);
  await Promise.all([fresh.dispose(), fresh.dispose()]);
  assert.deepEqual(await readdir(restarted.directory), []);
  await untouched.dispose();
  await Promise.all([restarted.close(), other.close()]);
});

test("refuses a symlinked image root instead of touching its target", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "racco-image-root-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sentinel = join(root, "sentinel");
  await writeFile(sentinel, "keep");
  await symlink(root, join(root, "racco-images"));
  await assert.rejects(
    TemporaryImages.open(join(root, "state"), { warn() {} }, root),
    /Unsafe/,
  );
  assert.equal(await readFile(sentinel, "utf8"), "keep");
});

test(
  "failed removal is retried instead of forgetting the temporary batch",
  { skip: process.getuid?.() === 0 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "racco-image-retry-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, "state"));
    let warnings = 0;
    const images = await TemporaryImages.open(
      join(root, "state"),
      {
        warn() {
          warnings++;
        },
      },
      root,
    );
    const batch = await images.create(content);
    try {
      await chmod(images.directory, 0o500);
      await batch.dispose();
      assert.equal(warnings, 1);
    } finally {
      await chmod(images.directory, 0o700);
    }
    await images.retryCleanup();
    assert.deepEqual(await readdir(images.directory), []);
    await images.close();
  },
);

test("state directory aliases share the same startup cleanup scope", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "racco-image-alias-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = join(root, "state"),
    alias = join(root, "state-alias");
  await mkdir(state);
  await symlink(state, alias);
  const original = await TemporaryImages.open(state, { warn() {} }, root);
  const batch = await original.create(content);
  await original.close();
  const restarted = await TemporaryImages.open(alias, { warn() {} }, root);
  assert.equal(restarted.directory, original.directory);
  await assert.rejects(readFile(batch.paths[0]), { code: "ENOENT" });
  await restarted.close();
});

test("closing an already removed runtime image directory succeeds", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "racco-image-already-clean-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = join(root, "state");
  await mkdir(state);
  const images = await TemporaryImages.open(state, { warn() {} }, root);
  await rm(images.directory, { recursive: true, force: true });
  await images.close();
  await images.close();
  await assert.rejects(lstat(images.directory), { code: "ENOENT" });
});
