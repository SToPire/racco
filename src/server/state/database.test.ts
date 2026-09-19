import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openRaccoStateDatabase } from "./database.js";
import { CURRENT_SCHEMA_VERSION } from "./schema.js";

test("allows only one Racco process to own a state directory", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "racco-lock-"));
  t.after(() => rm(directory, { force: true, recursive: true }));

  const first = openRaccoStateDatabase(directory);
  assert.throws(
    () => openRaccoStateDatabase(directory),
    /Another Racco process/,
  );
  first.close();

  const reopened = openRaccoStateDatabase(directory);
  reopened.database.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION - 1}`);
  reopened.close();
  assert.throws(
    () => openRaccoStateDatabase(directory),
    /schema .* is unsupported/,
  );
  assert.equal(existsSync(join(directory, "racco.lock")), false);
});
