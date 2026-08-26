import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, migrate, transact, ensureHousehold } from "./db.ts";
import { MIGRATIONS } from "./schema.ts";

function open() {
  return openDatabase({ path: ":memory:", verbose: false });
}

describe("migrations", () => {
  test("bring a fresh database to the current version", () => {
    const db = open();
    const { user_version } = db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    assert.equal(user_version, MIGRATIONS.length);
    db.close();
  });

  test("are idempotent — a second run applies nothing", () => {
    const db = open();
    migrate(db, false);
    migrate(db, false);
    const { user_version } = db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    assert.equal(user_version, MIGRATIONS.length);
    db.close();
  });

  test("refuse a database written by a newer build", () => {
    const db = open();
    db.exec(`PRAGMA user_version = ${MIGRATIONS.length + 5}`);
    assert.throws(() => migrate(db, false), /Refusing to start/);
    db.close();
  });

  test("create every table the app expects", () => {
    const db = open();
    const names = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
        name: string;
      }[]).map((r) => r.name),
    );
    for (const expected of [
      "household", "members", "sessions", "api_tokens", "events",
      "idempotency_keys", "accounts", "cards", "category_groups", "categories",
      "assignments", "held_for_next_month", "targets", "autoassign_rules",
      "payees", "payee_aliases", "transactions", "transaction_splits", "tags",
      "transaction_tags", "import_batches", "import_profiles",
      "staged_transactions", "rules", "rule_applications", "review_dismissals",
      "reconciliations", "schedules", "job_runs", "settings_kv",
    ]) {
      assert.ok(names.has(expected), `missing table: ${expected}`);
    }
    db.close();
  });
});

describe("constraints", () => {
  test("enforce foreign keys", () => {
    const db = open();
    assert.throws(
      () =>
        db
          .prepare("INSERT INTO categories (id, group_id, name, created_at) VALUES (?,?,?,?)")
          .run("c1", "no-such-group", "Groceries", "2026-08-26T10:00:00+05:30"),
      /FOREIGN KEY/,
    );
    db.close();
  });

  test("allow only one payment category per credit account", () => {
    const db = open();
    db.prepare(
      "INSERT INTO accounts (id,name,kind,subtype,opening_date,created_at) VALUES (?,?,?,?,?,?)",
    ).run("a1", "HDFC Card", "credit", "credit-card", "2026-08-01", "2026-08-01T00:00:00+05:30");
    db.prepare("INSERT INTO category_groups (id,name,kind,created_at) VALUES (?,?,?,?)").run(
      "g1", "Credit Card Payments", "credit-payments", "2026-08-01T00:00:00+05:30",
    );
    const insert = db.prepare(
      "INSERT INTO categories (id,group_id,name,payment_account_id,created_at) VALUES (?,?,?,?,?)",
    );
    insert.run("c1", "g1", "HDFC Card", "a1", "2026-08-01T00:00:00+05:30");
    assert.throws(
      () => insert.run("c2", "g1", "HDFC Card again", "a1", "2026-08-01T00:00:00+05:30"),
      /UNIQUE/,
    );
    db.close();
  });

  test("reject an unknown account kind", () => {
    const db = open();
    assert.throws(
      () =>
        db
          .prepare("INSERT INTO accounts (id,name,kind,subtype,opening_date,created_at) VALUES (?,?,?,?,?,?)")
          .run("a1", "Odd", "investment", "x", "2026-08-01", "2026-08-01T00:00:00+05:30"),
      /CHECK/,
    );
    db.close();
  });

  test("guarantee import idempotency (I5) via the source-id index", () => {
    const db = open();
    db.prepare(
      "INSERT INTO accounts (id,name,kind,subtype,opening_date,created_at) VALUES (?,?,?,?,?,?)",
    ).run("a1", "HDFC", "budget", "savings", "2026-08-01", "2026-08-01T00:00:00+05:30");
    const insert = db.prepare(
      "INSERT INTO transactions (id,account_id,date,amount,source,source_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
    );
    insert.run("t1", "a1", "2026-08-01", -100, "csv", "batch:row:1", "x", "x");
    assert.throws(() => insert.run("t2", "a1", "2026-08-01", -100, "csv", "batch:row:1", "x", "x"), /UNIQUE/);
    // A manually entered transaction has no source id and never collides.
    insert.run("t3", "a1", "2026-08-01", -100, "manual", null, "x", "x");
    insert.run("t4", "a1", "2026-08-01", -100, "manual", null, "x", "x");
    db.close();
  });
});

describe("transact", () => {
  test("rolls back on throw", () => {
    const db = open();
    ensureHousehold(db);
    assert.throws(() =>
      transact(db, () => {
        db.prepare("UPDATE household SET name = ? WHERE id = 1").run("Changed");
        throw new Error("boom");
      }),
    );
    const { name } = db.prepare("SELECT name FROM household WHERE id = 1").get() as {
      name: string;
    };
    assert.equal(name, "Household");
    db.close();
  });

  test("joins an outer transaction rather than nesting", () => {
    const db = open();
    ensureHousehold(db);
    const result = transact(db, () =>
      transact(db, () => {
        db.prepare("UPDATE household SET name = ? WHERE id = 1").run("Nested");
        return 42;
      }),
    );
    assert.equal(result, 42);
    const { name } = db.prepare("SELECT name FROM household WHERE id = 1").get() as {
      name: string;
    };
    assert.equal(name, "Nested");
    db.close();
  });

  test("an inner failure rolls back the whole outer unit of work", () => {
    const db = open();
    ensureHousehold(db);
    assert.throws(() =>
      transact(db, () => {
        db.prepare("UPDATE household SET name = ? WHERE id = 1").run("Outer");
        transact(db, () => {
          throw new Error("inner boom");
        });
      }),
    );
    const { name } = db.prepare("SELECT name FROM household WHERE id = 1").get() as {
      name: string;
    };
    assert.equal(name, "Household");
    db.close();
  });
});

describe("ensureHousehold", () => {
  test("creates the singleton once with the documented defaults", () => {
    const db = open();
    ensureHousehold(db);
    ensureHousehold(db);
    const rows = db.prepare("SELECT * FROM household").all() as Record<string, unknown>[];
    assert.equal(rows.length, 1);
    // Q1: Actual's model is the default. Q6: auto-assign off at rollover.
    assert.equal(rows[0]!.overspend_model, "reduce-rta");
    assert.equal(rows[0]!.auto_assign_on_rollover, 0);
    assert.equal(rows[0]!.fiscal_year_start_month, 4);
    db.close();
  });
});
