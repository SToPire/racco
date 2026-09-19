import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initializeStateSchema } from "./schema.js";

type LockPayload = {
  pid: number;
  token: string;
};

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLock(path: string): LockPayload | undefined {
  try {
    const value = JSON.parse(
      readFileSync(path, "utf8"),
    ) as Partial<LockPayload>;
    return typeof value.pid === "number" && typeof value.token === "string"
      ? {
          pid: value.pid,
          token: value.token,
        }
      : undefined;
  } catch {
    return undefined;
  }
}

class InstanceLock {
  readonly #token: string;
  #released = false;

  private constructor(
    private readonly path: string,
    token: string,
  ) {
    this.#token = token;
  }

  static acquire(path: string): InstanceLock {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const descriptor = openSync(path, "wx", 0o600);
        try {
          const payload: LockPayload = {
            pid: process.pid,
            token: randomUUID(),
          };
          writeFileSync(descriptor, JSON.stringify(payload), "utf8");
          return new InstanceLock(path, payload.token);
        } finally {
          closeSync(descriptor);
        }
      } catch (error) {
        const failure = error as NodeJS.ErrnoException;
        if (failure.code !== "EEXIST") throw error;
        const existing = readLock(path);
        if (existing !== undefined && processIsAlive(existing.pid)) {
          throw new Error(
            `Another Racco process is using this state directory (pid ${existing.pid})`,
          );
        }
        try {
          unlinkSync(path);
        } catch (unlinkError) {
          if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT")
            throw unlinkError;
        }
      }
    }
    throw new Error("Could not acquire the Racco state lock");
  }

  release(): void {
    if (this.#released) return;
    this.#released = true;
    const existing = readLock(this.path);
    if (existing?.token !== this.#token) return;
    try {
      unlinkSync(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
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
