/**
 * B105 · Migrations, run against a database that has something in it.
 *
 * Every other test in the suite starts from an empty database, which makes a
 * whole class of migration bug invisible: rebuilding a table behaves quite
 * differently when other tables hold rows pointing at it. Migration 0026 passed
 * 851 tests and then failed on the first real database it met.
 *
 * So this stops at the version before each rebuild, writes rows into the tables
 * that reference the table about to be rebuilt, and applies the rest.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrate } from "./db.ts";
import { MIGRATIONS } from "./schema.ts";

/** The migrations that rebuild a table, by the version they arrive at. */
const REBUILDS = MIGRATIONS
  .map((m, i) => ({ name: m.name, version: i + 1, rebuilds: Boolean(m.rebuildsTable) }))
  .filter((m) => m.rebuilds);

function open(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

describe("B105 · a rebuild survives a database with data in it", () => {
  test("at least one migration is marked as rebuilding a table", () => {
    // If this ever goes to zero the tests below are vacuous, and silently so.
    assert.ok(REBUILDS.length > 0, "expected at least one rebuildsTable migration");
  });

  for (const rebuild of REBUILDS) {
    test(`${rebuild.name} · applies over existing accounts and their children`, () => {
      const db = open();
      migrate(db, false, rebuild.version - 1);

      // An account, and a row in each table that points at one. These are the
      // rows whose foreign keys a DROP TABLE on the parent would fault.
      db.exec(`
        INSERT INTO members (id,email,name,created_at)
          VALUES ('m1','ravi@example.com','Ravi','2026-01-01T00:00:00+05:30');
        INSERT INTO accounts (id,name,kind,subtype,opening_balance,opening_date,created_at)
          VALUES ('a1','Joint current','budget','savings',5000000,'2026-01-01','2026-01-01T00:00:00+05:30');
        INSERT INTO accounts (id,name,kind,subtype,opening_balance,opening_date,created_at)
          VALUES ('a2','Card','credit','credit_card',-100000,'2026-01-01','2026-01-01T00:00:00+05:30');
        INSERT INTO category_groups (id,name,kind,sort,created_at)
          VALUES ('g1','Spending','normal',1,'2026-01-01T00:00:00+05:30');
        INSERT INTO categories (id,group_id,name,sort,created_at)
          VALUES ('c1','g1','Groceries',1,'2026-01-01T00:00:00+05:30');
        INSERT INTO transactions (id,account_id,date,amount,category_id,created_at,updated_at)
          VALUES ('t1','a1','2026-01-05',-250000,'c1',
                  '2026-01-05T00:00:00+05:30','2026-01-05T00:00:00+05:30');
        INSERT INTO transactions (id,account_id,date,amount,category_id,created_at,updated_at)
          VALUES ('t2','a2','2026-01-06',-150000,'c1',
                  '2026-01-06T00:00:00+05:30','2026-01-06T00:00:00+05:30');
      `);

      migrate(db, false);

      assert.equal(
        (db.prepare(`PRAGMA foreign_key_check`).all() as unknown[]).length, 0,
        "the rebuild left rows pointing at nothing",
      );
      // Enforcement must be back on afterwards, or every later write is unguarded.
      assert.equal(
        (db.prepare(`PRAGMA foreign_keys`).get() as { foreign_keys: number }).foreign_keys, 1,
      );
      // The data came through, and the children still resolve.
      assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM accounts`).get() as { n: number }).n, 2);
      assert.equal(
        (db.prepare(
          `SELECT COUNT(*) AS n FROM transactions t JOIN accounts a ON a.id = t.account_id`,
        ).get() as { n: number }).n,
        2,
      );
      db.close();
    });
  }

  test("the rollup triggers on accounts survive the rebuild", () => {
    // B74's ground: a rebuild drops the table's triggers with it, and without
    // them the month cache goes stale the moment an account changes.
    const db = open();
    migrate(db, false);
    const triggers = (db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'accounts'`,
    ).all() as { name: string }[]).map((r) => r.name).sort();
    assert.deepEqual(triggers, ["trg_rollup_account_insert", "trg_rollup_account_update"]);
    db.close();
  });
});
