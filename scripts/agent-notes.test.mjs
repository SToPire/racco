import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { root } from "./lib/process.mjs";

test("notes check requires no Git history and catches stale current references", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "racco-notes-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const notes = join(directory, ".agents/notes");
  await mkdir(join(notes, "implemented/process"), { recursive: true });
  for (const name of ["README.md", "AGENTS.md", "implemented/AGENTS.md"])
    await writeFile(join(notes, name), "# Current rules\n");
  await writeFile(join(directory, "README.md"), "# Setup\n");
  const note = join(notes, "implemented/process/2026-10-02-decision.md");
  const content =
    "# Agent Note: Ownership\n\nStatus: implemented\n\n## Problem\n\nTwo writers.\n\n## Decision\n\nOne owner; see [setup](../../../../README.md#setup).\n\n## Alternatives considered\n\nTwo writers add coordination.\n\n## Consequences\n\nOwner must release resources.\n";
  await writeFile(note, content);
  const args = [
    join(root, "scripts/agent_notes.py"),
    "--root",
    directory,
    "check",
  ];
  assert.match(
    execFileSync("python3", args, { encoding: "utf8" }),
    /check: OK/,
  );
  // Routine implementation changes do not need an otherwise empty note update.
  await writeFile(
    join(directory, "routine-fix.js"),
    "export const fixed = true;\n",
  );
  assert.match(
    execFileSync("python3", args, { encoding: "utf8" }),
    /check: OK/,
  );
  for (const [replacement, error] of [
    [content.replace("#setup", "#removed-heading"), /missing heading link/],
    [content.replace("README.md#setup", "removed.md"), /missing local link/],
    [
      content.replace("Status: implemented", "Status: proposed"),
      /invalid title\/status/,
    ],
  ]) {
    await writeFile(note, replacement);
    const result = spawnSync("python3", args, { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, error);
  }
});
