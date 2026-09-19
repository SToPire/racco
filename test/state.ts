import { DatabaseSync } from "node:sqlite";
import { initializeStateSchema } from "../src/server/state/schema.js";
import { SessionRepository } from "../src/server/state/session-repository.js";

export function memoryRepository(
  database = new DatabaseSync(":memory:"),
  close?: () => void,
) {
  database.exec("PRAGMA foreign_keys = ON");
  initializeStateSchema(database);
  return new SessionRepository(database, close);
}
