import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveFileReference,
  resolveProjectFilePath,
} from "./file-navigation";

test("resolves relative and project-contained absolute references with line locations", () => {
  for (const reference of [
    "src/main.ts#L42",
    "./src/main.ts:42",
    "/work/app/src/main.ts:42",
    "src/../src/main.ts:42:3",
  ]) {
    assert.deepEqual(
      resolveFileReference(reference, "/work/app", "/work/app"),
      {
        kind: "file",
        path: "src/main.ts",
        line: 42,
      },
    );
  }
  assert.deepEqual(
    resolveFileReference("README.md", "/work/app", "/work/app"),
    {
      kind: "file",
      path: "README.md",
    },
  );
  assert.deepEqual(
    resolveFileReference("docs/My%20Notes.md#L2", "/work/app/", "/work/app/"),
    { kind: "file", path: "docs/My Notes.md", line: 2 },
  );
  assert.deepEqual(
    resolveFileReference("Dockerfile:1", "/work/app", "/work/app"),
    {
      kind: "file",
      path: "Dockerfile",
      line: 1,
    },
  );
});

test("rejects traversal, root-prefix lookalikes and encoded boundary escapes", () => {
  for (const reference of [
    "../secret",
    "src/../../secret",
    "%2e%2e/secret",
    "/work/app-other/key",
    "/work/app/../key",
    "%2Fetc%2Fpasswd",
    "/work/app",
    "src/",
    "file%00.ts",
  ]) {
    assert.equal(
      resolveFileReference(reference, "/work/app", "/work/app").kind,
      "unavailable",
      reference,
    );
  }
});

test("keeps external URLs and ordinary document fragments as links", () => {
  for (const reference of [
    "https://example.com/code.ts#L3",
    "//example.com/code",
    "mailto:dev@example.com",
    "tel:123456",
    "#discussion",
    "?search=term",
    "javascript:alert(1)",
  ]) {
    assert.deepEqual(
      resolveFileReference(reference, "/work/app", "/work/app"),
      { kind: "external" },
      reference,
    );
  }
});

test("invalid locations do not silently open another file or line", () => {
  for (const reference of [
    "main.ts:0",
    "main.ts#L0",
    "main.ts#L99999999999999999",
    "main.ts#section",
    "main.ts?raw=true",
    "src/%GG.ts",
  ]) {
    assert.equal(
      resolveFileReference(reference, "/work/app", "/work/app").kind,
      "unavailable",
      reference,
    );
  }
});

test("literal tool paths preserve percent signs, hashes and colons instead of parsing URL locations", () => {
  const path = "src/a%20b#L2:5.ts";
  assert.deepEqual(
    resolveProjectFilePath(`/work/app/${path}`, "/work/app", "/work/app"),
    {
      kind: "file",
      path,
    },
  );
  assert.deepEqual(
    resolveProjectFilePath("main.ts:42", "/work/app", "/work/app"),
    {
      kind: "file",
      path: "main.ts:42",
    },
  );
});

test("relative references use the actor directory while keeping the session project as the boundary", () => {
  assert.deepEqual(
    resolveFileReference("README.md#L2", "/work/app", "/work/app/packages"),
    {
      kind: "file",
      path: "packages/README.md",
      line: 2,
    },
  );
  assert.deepEqual(
    resolveFileReference("../README.md:5", "/work/app", "/work/app/packages"),
    {
      kind: "file",
      path: "README.md",
      line: 5,
    },
  );
  assert.deepEqual(
    resolveProjectFilePath("a%20b#L2:5.ts", "/work/app", "/work/app/packages"),
    {
      kind: "file",
      path: "packages/a%20b#L2:5.ts",
    },
  );
  assert.equal(
    resolveFileReference("../../secret", "/work/app", "/work/app/packages")
      .kind,
    "unavailable",
  );
});

test("unknown or external actor directories never reinterpret relative references as root files", () => {
  for (const base of [undefined, "/work/other", "/work/app-other"]) {
    assert.equal(
      resolveFileReference("README.md", "/work/app", base).kind,
      "unavailable",
    );
    assert.equal(
      resolveProjectFilePath("README.md", "/work/app", base).kind,
      "unavailable",
    );
    assert.deepEqual(
      resolveFileReference("/work/app/README.md", "/work/app", base),
      { kind: "file", path: "README.md" },
    );
  }
});
