/**
 * The import data-fix migrations, against rows shaped the way old imports
 * stored them. Same approach as data-fix-0043-0044.test.ts: build with today's
 * schema, write the old shape directly, rewind user_version to 44, migrate.
 *
 *   0045 · Uniqueness of an imported row covered deleted rows, so approving a
 *          re-import of an undone row failed with a UNIQUE constraint — a 500,
 *          on every Gmail fetch that re-read the same fortnight.
 *   0046 · Old PDF/email approvals were stored as source "csv"; raw_date never
 *          reached the ledger; PDF/email raw columns held computed values; and
 *          email narrations carried an invented "[card of …]" tag.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, queryOne, migrate, type DB } from "./db.ts";
import { nowIST } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import type { Actor } from "../core/events.ts";
import { createAccount } from "../domain/accounts.ts";

const actor: Actor = { memberId: "m", source: "ui" };
const T = "2026-09-01T10:00:00.000+05:30";

function household(): { db: DB; bank: string } {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`, "m", "f@e.com", "Ravi", nowIST());
  const bank = createAccount(db, actor, { name: "Bank", kind: "budget", subtype: "savings",
    openingDate: "2026-08-01", openingBalance: rupees(10_000) }).id;
  return { db, bank };
}

function importedRow(db: DB, id: string, bank: string, batch: string, opts: {
  source: string; sourceId: string; deleted?: boolean; rawDate?: string | null; rawAmount?: string | null; narration?: string;
}): void {
  execute(db,
    `INSERT INTO transactions (id,account_id,date,amount,source,source_id,import_batch_id,raw_date,raw_amount,raw_narration,deleted_at,created_at,updated_at)
     VALUES (?,?,'2026-09-02',-45000,?,?,?,?,?,?,?,?,?)`,
    id, bank, opts.source, opts.sourceId, batch, opts.rawDate ?? null, opts.rawAmount ?? null,
    opts.narration ?? "SHOP", opts.deleted ? T : null, T, T);
}

function batch(db: DB, id: string, bank: string, source: string): void {
  execute(db, `INSERT INTO import_batches (id,source,adapter,account_id,member_id,created_at) VALUES (?,?,?,?,'m',?)`,
    id, source, source, bank, T);
}

function rewindAndMigrate(db: DB): void {
  db.exec("PRAGMA user_version = 44");
  migrate(db, false);
}

describe("0045 · uniqueness covers live rows only", () => {
  test("a deleted import no longer blocks the same row arriving again", () => {
    const { db, bank } = household();
    batch(db, "b1", bank, "csv");
    rewindAndMigrate(db);
    importedRow(db, "t1", bank, "b1", { source: "csv", sourceId: "row-7", deleted: true });
    // Under the old index this second insert failed: UNIQUE constraint.
    importedRow(db, "t2", bank, "b1", { source: "csv", sourceId: "row-7" });
    assert.throws(
      () => importedRow(db, "t3", bank, "b1", { source: "csv", sourceId: "row-7" }),
      /UNIQUE/, "two LIVE copies of one imported row must still be impossible",
    );
  });
});

describe("0046 · what old imports stored is corrected", () => {
  test("source, raw date, computed raw values and the invented card tag", () => {
    const { db, bank } = household();
    batch(db, "pdf1", bank, "pdf");
    batch(db, "csv1", bank, "csv");
    importedRow(db, "p1", bank, "pdf1", { source: "csv", sourceId: "p-1", rawDate: "2026-09-02", rawAmount: "-450",
      narration: "SWIGGY [card of Priya]" });
    importedRow(db, "c1", bank, "csv1", { source: "csv", sourceId: "c-1", rawDate: null, rawAmount: "450.00" });
    execute(db,
      `INSERT INTO staged_transactions (id,batch_id,account_id,row_number,date,amount,raw_date,status,transaction_id,resolved_at,created_at)
       VALUES ('s1','csv1',?,1,'2026-09-02',-45000,'02/09/2026','approved','c1',?,?)`, bank, T, T);

    rewindAndMigrate(db);

    const p1 = queryOne<Record<string, string | null>>(db, `SELECT * FROM transactions WHERE id = 'p1'`)!;
    assert.equal(p1.source, "pdf", "a PDF row still claims to have come from a CSV");
    assert.equal(p1.raw_date, null, "a computed ISO date still poses as the printed text");
    assert.equal(p1.raw_amount, null);
    assert.equal(p1.raw_narration, "SWIGGY", "the invented card tag is still there");

    const c1 = queryOne<Record<string, string | null>>(db, `SELECT * FROM transactions WHERE id = 'c1'`)!;
    assert.equal(c1.raw_date, "02/09/2026", "the staged row's raw date never reached the ledger");
    assert.equal(c1.raw_amount, "450.00", "a CSV's genuine raw text was touched");
  });
});
