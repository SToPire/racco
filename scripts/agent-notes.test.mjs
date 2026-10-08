import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const checker = fileURLToPath(new URL("./agent_notes.py", import.meta.url));

async function write(directory, path, content = "Local review findings.\n") {
  const target = join(directory, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}

function git(directory, ...args) {
  const result = spawnSync("git", ["-C", directory, ...args], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
}

async function repository(t) {
  const directory = await mkdtemp(join(tmpdir(), "racco-agent-notes-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  git(directory, "init", "--quiet");
  await write(directory, ".gitignore", ".tmp/\n");
  const notes = ".agents/notes";
  for (const lifecycle of ["proposed", "implemented", "rejected", "archived"]) {
    for (const kind of [
      "architecture",
      "process",
      "feature",
      "bug-fix",
      "simplification",
      "testing",
    ]) {
      await mkdir(join(directory, notes, lifecycle, kind), { recursive: true });
    }
  }
  for (const path of [
    "README.md",
    "AGENTS.md",
    "implemented/AGENTS.md",
    "archived/AGENTS.md",
  ]) {
    await write(directory, `${notes}/${path}`, "# Agent Notes\n");
  }
  await write(directory, `${notes}/.gitattributes`, "*.md text eol=lf\n");
  await write(
    directory,
    `${notes}/archived/manifest.json`,
    '{"version":1,"files":{}}\n',
  );
  return directory;
}

function check(directory) {
  const env = { ...process.env };
  delete env.AGENT_NOTES_BASE_REF;
  return spawnSync("python3", [checker, "--root", directory, "check"], {
    encoding: "utf8",
    env,
  });
}

test("notes check rejects an unstaged design outside Agent Notes", async (t) => {
  const directory = await repository(t);
  await write(directory, "docs/designs/new-design.md");
  const result = check(directory);
  assert.equal(result.status, 1, result.stderr);
  assert.match(
    result.stderr,
    /docs\/designs\/new-design\.md.*\.agents\/notes\//,
  );
});

test("notes check rejects versioned docs even when their path is ignored", async (t) => {
  const directory = await repository(t);
  await write(directory, ".gitignore", ".tmp/\ndocs/\n");
  await write(directory, "docs/reviews/previous-review.md");
  git(directory, "add", "-f", "docs/reviews/previous-review.md");
  const result = check(directory);
  assert.equal(result.status, 1, result.stderr);
  assert.match(
    result.stderr,
    /docs\/reviews\/previous-review\.md.*not allowed/,
  );
});

test("notes check rejects force-added local review artifacts", async (t) => {
  const directory = await repository(t);
  await write(directory, ".tmp/reviews/findings.json", "{}\n");
  git(directory, "add", "-f", ".tmp/reviews/findings.json");
  const result = check(directory);
  assert.equal(result.status, 1, result.stderr);
  assert.match(
    result.stderr,
    /\.tmp\/reviews\/findings\.json.*must not be versioned/,
  );
});

test("notes check allows review skills, source fields, and ignored local records", async (t) => {
  const directory = await repository(t);
  await write(directory, ".tmp/reviews/findings.md");
  await write(
    directory,
    ".agents/skills/agent-notes-review/SKILL.md",
    "# Review Agent Notes\n",
  );
  await write(directory, "src/review.ts", 'export const review = "pending";\n');
  git(
    directory,
    "add",
    ".agents/skills/agent-notes-review/SKILL.md",
    "src/review.ts",
  );
  const result = check(directory);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Agent Notes check: OK/);
});
