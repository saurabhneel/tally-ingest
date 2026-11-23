import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type Db = Database.Database;

/**
 * Open the SQLite database with production-minded settings.
 * Pass ':memory:' for tests.
 */
export function openDatabase(dbPath: string): Db {
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(resolve(dbPath)), { recursive: true });
  }

  const db = new Database(dbPath);

  // Without this, SQLite ignores every FOREIGN KEY and ON DELETE CASCADE.
  db.pragma("foreign_keys = ON");
  // WAL lets readers run while a write is in progress.
  db.pragma("journal_mode = WAL");
  // Safe with WAL, and much faster than FULL.
  db.pragma("synchronous = NORMAL");
  // If another connection holds the write lock, wait instead of failing instantly.
  db.pragma("busy_timeout = 5000");

  return db;
}
