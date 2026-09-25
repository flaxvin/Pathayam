/**
 * D10 · What still points at a row that an undo is about to remove.
 *
 * Undoing the "create" of a group, a category, a loan or a payee deleted the
 * row unconditionally. Anything created since that pointed at it — a category
 * in the group, an assignment or a transaction in the category, the EMI plan's
 * instalments on the loan, a transaction naming the payee — made the DELETE hit
 * a foreign key, and the household got "Something went wrong" (a plain
 * `Error`, so a 500) instead of a sentence. `accountDependants` already did
 * this for accounts; this is the same idea for any table, read from the
 * schema's own foreign keys so a table added later is covered without anyone
 * remembering to list it here.
 */

import type { DB } from "../db/db.ts";
import { queryAll, queryOne } from "../db/db.ts";

export interface DependantOptions {
  /** `table.column` references that go with the row (deleted alongside it). */
  own?: string[];
  /** Plain words for a referencing table; the table name is used otherwise. */
  words?: Record<string, string>;
}

/** Plain words for every table (and column) that still refers to `id` in `table`. */
export function dependantsOf(db: DB, table: string, id: string, opts: DependantOptions = {}): string[] {
  const own = new Set(opts.own ?? []);
  const found: string[] = [];
  const tables = queryAll<{ name: string }>(
    db, `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
  );
  for (const { name } of tables) {
    const fks = queryAll<{ table: string; from: string; on_delete: string }>(
      db, `PRAGMA foreign_key_list(${name})`,
    );
    for (const fk of fks) {
      if (fk.table !== table || own.has(`${name}.${fk.from}`) || fk.on_delete === "CASCADE") continue;
      // A row does not stop itself being deleted (payees.merged_into_id, say).
      const self = name === table ? " AND id <> ?" : "";
      const n = queryOne<{ n: number }>(
        db, `SELECT COUNT(*) AS n FROM ${name} WHERE ${fk.from} = ?${self}`,
        ...(self ? [id, id] : [id]),
      )?.n ?? 0;
      if (n > 0) found.push(opts.words?.[name] ?? name.replace(/_/g, " "));
    }
  }
  return [...new Set(found)];
}
