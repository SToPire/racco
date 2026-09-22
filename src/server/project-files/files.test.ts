import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  mkdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { listProjectFiles, readProjectFile } from "./files.js";
import { projectFileRoutes } from "./routes.js";

async function fixture(t: test.TestContext) {
  const container = await mkdtemp(join(tmpdir(), "racco-files-"));
  t.after(() => rm(container, { recursive: true, force: true }));
  const root = join(container, "project");
  await mkdir(join(root, "src"), { recursive: true });
  await Promise.all([
    writeFile(
      join(root, "README.md"),
      "# Hello\n你好 🌍\n<script>neverExecute()</script>\n",
    ),
    writeFile(join(root, ".env"), "EXAMPLE=true\n"),
    writeFile(join(root, "src", "hello.ts"), "const value = 1;\n"),
    writeFile(join(container, "outside.txt"), "outside"),
  ]);
  await Promise.all([
    symlink(join(root, "src"), join(root, "source-link")),
    symlink(join(container, "outside.txt"), join(root, "outside-link")),
    symlink(join(container, "missing"), join(root, "broken-link")),
  ]);
  return { container, root };
}

test("lists a single project directory including dotfiles and marks unavailable links", async (t) => {
  const { root } = await fixture(t);
  const listing = await listProjectFiles(root);
  assert.deepEqual(
    listing.entries
      .filter((entry) => entry.kind === "directory")
      .map((entry) => entry.name),
    ["source-link", "src"],
  );
  assert.equal(
    listing.entries.find((entry) => entry.name === ".env")?.kind,
    "file",
  );
  assert.equal(
    listing.entries.find((entry) => entry.name === "outside-link")?.kind,
    "unavailable",
  );
  assert.equal(
    listing.entries.find((entry) => entry.name === "broken-link")?.kind,
    "unavailable",
  );
  assert.equal(
    listing.entries.some((entry) => entry.path === "src/hello.ts"),
    false,
  );
  assert.equal(
    (await listProjectFiles(root, "source-link")).entries[0]?.path,
    "source-link/hello.ts",
  );
});

test("reads UTF-8 verbatim and only resolves links inside the selected project", async (t) => {
  const { root } = await fixture(t);
  const preview = await readProjectFile(root, "README.md");
  assert.equal(preview.kind, "text");
  if (preview.kind === "text")
    assert.equal(
      preview.content,
      "# Hello\n你好 🌍\n<script>neverExecute()</script>\n",
    );
  assert.equal(
    (await readProjectFile(root, "source-link/hello.ts")).kind,
    "text",
  );
  for (const path of [
    "../outside.txt",
    "outside-link",
    "src/../../outside.txt",
  ]) {
    await assert.rejects(readProjectFile(root, path), /项目目录/);
  }
  await assert.rejects(readProjectFile(root, "/etc/passwd"), /相对于/);
  await assert.rejects(listProjectFiles(root, "../"), /项目目录/);
  await assert.rejects(readProjectFile(root, "src"), /普通文件/);
});

test("supports images and empty files, with bounded reads for large or binary files", async (t) => {
  const { root } = await fixture(t);
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=",
    "base64",
  );
  await Promise.all([
    writeFile(join(root, "empty"), ""),
    writeFile(join(root, "binary"), Buffer.from([0, 1, 2])),
    writeFile(join(root, "invalid-utf8"), Buffer.from([0xff, 0xfe])),
    writeFile(join(root, "large"), Buffer.alloc(2 * 1024 * 1024 + 1)),
    writeFile(join(root, "many-lines"), "\n".repeat(20001)),
    writeFile(join(root, "image.png"), png),
  ]);
  const empty = await readProjectFile(root, "empty");
  assert.equal(empty.kind, "text");
  if (empty.kind === "text") assert.equal(empty.content, "");
  for (const name of ["binary", "invalid-utf8", "large", "many-lines"])
    assert.equal((await readProjectFile(root, name)).kind, "unavailable");
  const image = await readProjectFile(root, "image.png");
  assert.equal(image.kind, "image");
  if (image.kind === "image")
    assert.equal(
      image.dataUrl,
      `data:image/png;base64,${png.toString("base64")}`,
    );
});

test("file endpoints require an available worktree, validate input and reject cross-site access", async (t) => {
  const { root } = await fixture(t);
  const app = Fastify();
  await app.register(projectFileRoutes, {
    worktreeIsAvailable: async (path) => path === root,
  });
  t.after(() => app.close());
  const file = `/api/worktrees/file?path=${encodeURIComponent(root)}&file=README.md`;
  const response = await app.inject({ url: file });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(
    (
      await app.inject({
        url: `/api/worktrees/tree?path=${encodeURIComponent(root)}`,
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await app.inject({
        url: "/api/worktrees/file?path=%2Ftmp%2Fnope&file=README.md",
      })
    ).statusCode,
    404,
  );
  for (const query of [
    "",
    "?path=",
    `?path=${encodeURIComponent(root)}&extra=1`,
    `?path=${encodeURIComponent(root)}&file=README.md&file=.env`,
    `?path=${encodeURIComponent(root)}&file=%00`,
  ]) {
    assert.equal(
      (await app.inject({ url: "/api/worktrees/file" + query })).statusCode,
      400,
    );
  }
  assert.equal(
    (
      await app.inject({
        url: file,
        headers: { origin: "https://foreign.example" },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        url: file,
        headers: { "sec-fetch-site": "cross-site" },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        url: `/api/worktrees/file?path=${encodeURIComponent(root)}&file=outside-link`,
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        url: `/api/worktrees/file?path=${encodeURIComponent(root)}&file=missing`,
      })
    ).statusCode,
    404,
  );
  await writeFile(join(root, "denied"), "unreadable", { mode: 0o000 });
  assert.equal(
    (
      await app.inject({
        url: `/api/worktrees/file?path=${encodeURIComponent(root)}&file=denied`,
      })
    ).statusCode,
    403,
  );
  await chmod(join(root, "denied"), 0o600);
});
