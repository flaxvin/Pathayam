/**
 * Database handle and migration runner.
 *
 * SQLite via Node's built-in `node:sqlite`, so the container needs no native
 * build step and the file on disk is readable by the `sqlite3` CLI — which is
 * what R40.7 requires: a backup must be restorable without the application.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { MIGRATIONS } from "./schema.ts";
import { nowIST } from "../core/dates.ts";
import { randomUUID } from "node:crypto";

export type DB = DatabaseSync;

export interface OpenOptions {
  /** Path to the database file, or ":memory:" for tests. */
  path: string;
  /** Log each migration as it is applied. Default true. */
  verbose?: boolean;
}

export function openDatabase({ path, verbose = true }: OpenOptions): DB {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new DatabaseSync(path);

  // WAL lets the health page and backup job read while the app writes.
  // An in-memory database has no journal to switch.
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");

  migrate(db, verbose);
  return db;
}

export function migrate(db: DB, verbose = true): void {
  const { user_version: current } = db
    .prepare("PRAGMA user_version")
    .get() as { user_version: number };

  if (current > MIGRATIONS.length) {
    throw new Error(
      `Database is at schema version ${current} but this build only knows ${MIGRATIONS.length}. ` +
        `Refusing to start — a newer version of the app has written this file.`,
    );
  }

  for (let i = current; i < MIGRATIONS.length; i++) {
    const migration = MIGRATIONS[i]!;
    if (verbose) console.log(`[db] applying ${migration.name}`);
    db.exec("BEGIN");
    try {
      db.exec(migration.sql);
      // PRAGMA does not accept a bound parameter; the value is a loop index.
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(`Migration ${migration.name} failed: ${(err as Error).message}`, {
        cause: err,
      });
    }
  }
}

/**
 * Run `fn` inside a transaction, rolling back if it throws.
 *
 * Nested calls join the outer transaction rather than opening a second one,
 * which SQLite does not support — a mutation helper can therefore be called
 * standalone or as part of a larger unit of work without knowing which.
 */
export function transact<T>(db: DB, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The transaction was already rolled back; the original error is what matters.
    }
    throw err;
  }
}

/** Ensure the singleton household row exists. */
export function ensureHousehold(db: DB): void {
  const existing = db.prepare("SELECT id FROM household WHERE id = 1").get();
  if (!existing) {
    db.prepare("INSERT INTO household (id, created_at) VALUES (1, ?)").run(nowIST());
  }
}

export function newId(): string {
  return randomUUID();
}
