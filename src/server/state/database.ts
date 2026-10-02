import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initializeStateSchema } from "./schema.js";

class InstanceLock {
  #released = false;

  private constructor(private readonly descriptor: number) {}

  static acquire(path: string): InstanceLock {
    // Keep a stable inode: removing this file could let another process lock a
    // different inode while the current owner still holds its descriptor.
    const descriptor = openSync(path, "a+", 0o600);
    try {
      // The child shares our open-file description. Its exit leaves the lock
      // held by this descriptor until release() or process termination.
      const result = spawnSync(
        "flock",
        ["--nonblock", "--conflict-exit-code", "75", "3"],
        { stdio: ["ignore", "ignore", "pipe", descriptor], encoding: "utf8" },
      );
      if (result.error)
        throw new Error(
          `Could not run flock for the Racco state lock: ${result.error.message}`,
          { cause: result.error },
        );
      if (result.status === 75) {
        throw new Error("Another Racco process is using this state directory");
      }
      if (result.status !== 0)
        throw new Error(
          `Could not acquire the Racco state lock: ${result.stderr?.trim() || result.signal || result.status}`,
        );
      return new InstanceLock(descriptor);
    } catch (error) {
      closeSync(descriptor);
      throw error;
    }
  }

  release(): void {
    if (this.#released) return;
    this.#released = true;
    closeSync(this.descriptor);
  }
}

type RaccoStateDatabase = {
  database: DatabaseSync;
  close(): void;
};

export function openRaccoStateDatabase(stateDir: string): RaccoStateDatabase {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  const lock = InstanceLock.acquire(join(stateDir, "racco.lock"));
  const databasePath = join(stateDir, "racco.db");
  let database: DatabaseSync | undefined;

  try {
    database = new DatabaseSync(databasePath);
    chmodSync(databasePath, 0o600);
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA synchronous = FULL");
    initializeStateSchema(database);
    const openedDatabase = database;

    let closed = false;
    return {
      database: openedDatabase,
      close() {
        if (closed) return;
        closed = true;
        try {
          openedDatabase.close();
        } finally {
          lock.release();
        }
      },
    };
  } catch (error) {
    try {
      database?.close();
    } finally {
      lock.release();
    }
    throw error;
  }
}
