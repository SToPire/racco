import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { DirectoryBrowseError, listDirectories } from "./browser.js";
import { directoryRoutes } from "./routes.js";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "racco-directory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all([
    mkdir(join(root, "project-10")),
    mkdir(join(root, "project-2")),
    mkdir(join(root, ".hidden")),
    writeFile(join(root, "file.txt"), "data"),
  ]);
  await Promise.all([
    symlink(join(root, "project-2"), join(root, "shortcut")),
    symlink(join(root, "file.txt"), join(root, "file-link")),
    symlink(join(root, "missing"), join(root, "broken-link")),
  ]);
  return root;
}

test("lists one level, includes hidden folders and follows only directory links", async (t) => {
  const root = await fixture(t);
  const listing = await listDirectories(root);
  assert.equal(listing.path, root);
  assert.equal(listing.homePath, homedir());
  assert.equal(listing.truncated, false);
  assert.deepEqual(
    listing.entries.map((entry) => entry.name),
    [".hidden", "project-2", "project-10", "shortcut"],
  );
  assert.equal(listing.entries[0]?.hidden, true);
  const viaLink = await listDirectories(join(root, "shortcut"));
  assert.equal(viaLink.path, join(root, "project-2"));
  assert.equal(viaLink.parentPath, root);
  assert.deepEqual(viaLink.entries, []);
});

test("rejects relative, invalid, nonexistent and non-directory paths", async (t) => {
  const root = await fixture(t);
  for (const path of ["", "relative", "/bad\0path"]) {
    await assert.rejects(
      listDirectories(path),
      (error: unknown) =>
        error instanceof DirectoryBrowseError && error.statusCode === 400,
    );
  }
  for (const path of [join(root, "missing"), join(root, "file.txt")]) {
    await assert.rejects(
      listDirectories(path),
      (error: unknown) =>
        error instanceof DirectoryBrowseError && error.statusCode === 404,
    );
  }
});

test("reports directory permission failures", async (t) => {
  const root = await fixture(t);
  const denied = join(root, "denied");
  await mkdir(denied, { mode: 0o000 });
  t.after(() => chmod(denied, 0o700).catch(() => undefined));
  await assert.rejects(
    listDirectories(denied),
    (error: unknown) =>
      error instanceof DirectoryBrowseError && error.statusCode === 403,
  );
});

test("bounds large listings and reports that more directories exist", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "racco-large-directory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all(
    Array.from({ length: 1002 }, (_, index) =>
      mkdir(join(root, `folder-${index}`)),
    ),
  );
  const listing = await listDirectories(root);
  assert.equal(listing.entries.length, 1000);
  assert.equal(listing.truncated, true);
});

test("root navigation ends at the filesystem root", async () => {
  const listing = await listDirectories("/");
  assert.equal(listing.path, "/");
  assert.equal(listing.parentPath, null);
});

test("directory API validates queries, refuses cross-site reads and does not cache paths", async (t) => {
  const root = await fixture(t);
  const app = Fastify();
  await app.register(directoryRoutes);
  t.after(() => app.close());
  const url = `/api/directories?${new URLSearchParams({ path: root })}`;
  const success = await app.inject({ url });
  assert.equal(success.statusCode, 200);
  assert.equal(success.headers["cache-control"], "no-store");
  assert.equal(success.json().path, root);
  for (const url of [
    "/api/directories?path=",
    "/api/directories?extra=1",
    "/api/directories?path=/&path=/tmp",
    "/api/directories?path=relative",
  ]) {
    assert.equal((await app.inject({ url })).statusCode, 400);
  }
  assert.equal(
    (await app.inject({ url, headers: { origin: "https://foreign.example" } }))
      .statusCode,
    403,
  );
  assert.equal(
    (await app.inject({ url, headers: { "sec-fetch-site": "cross-site" } }))
      .statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        url: "/api/directories?path=/missing-racco-directory",
      })
    ).statusCode,
    404,
  );
});
