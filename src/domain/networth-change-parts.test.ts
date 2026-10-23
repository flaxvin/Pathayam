/**
 * NW-1 · The change in net worth, in parts that add up to it.
 *
 * The breakdown was money saved, market movement, exchange rate and debt
 * repaid. A flat revalued, money borrowed from family and an "other liability"
 * paid down all move net worth and were in none of them, so the parts did not
 * sum to the total change they explained. Snapshots now keep money owed to
 * family and other liabilities too; a period starting before they did shows
 * one balancing "Other" line instead.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrate, ensureHousehold, execute, queryOne, type DB } from "../db/db.ts";
import { MIGRATIONS } from "../db/schema.ts";
import { rupees, type Paise } from "../core/money.ts";
import { todayIST } from "../core/dates.ts";
import type { Actor } from "../core/events.ts";
import { createAccount } from "./accounts.ts";
import { createTransfer } from "./transactions.ts";
import { createAssetAccount, recordValuation, exportNetWorthCsv } from "./assets.ts";
import { createFamilyLoan, recordAdvance, recordRepayment } from "./family-loans.ts";
import { snapshotNetWorth, netWorthChange, type NetWorthChange } from "./networth.ts";
import { freshDb, seedMember } from "../web/harness.test-data.ts";

const ravi: Actor = { memberId: "m", source: "ui" };

const sumOfParts = (c: NetWorthChange) => c.parts.reduce((s, p) => s + p.value, 0);

/** A household with every kind of line the breakdown used to miss. */
function household(db: DB) {
  seedMember(db, "m", "Ravi");
  const bank = createAccount(db, ravi, {
    name: "Bank", kind: "budget", subtype: "savings", openingDate: "2025-01-01", openingBalance: rupees(5_00_000),
  }).id;
  const flat = createAssetAccount(db, ravi, { name: "Flat", subtype: "physical" }).id;
  recordValuation(db, ravi, { accountId: flat, value: rupees(50_00_000), asOf: "2025-02-01" });
  const dues = createAccount(db, ravi, {
    name: "Society dues", kind: "tracking", subtype: "liability",
    openingDate: "2025-01-01", openingBalance: -rupees(1_00_000) as Paise,
  }).id;
  const ammu = createFamilyLoan(db, ravi, { counterparty: "Ammu" }).id;
  // Ammu lends the household ₹30,000.
  recordRepayment(db, ravi, { loanId: ammu, amount: rupees(30_000), date: "2025-02-10", accountId: bank });
  return { bank, flat, dues, ammu };
}

/** March: the flat is revalued, Ammu is paid back ₹10,000, the dues ₹20,000. */
function march(db: DB, h: ReturnType<typeof household>) {
  recordValuation(db, ravi, { accountId: h.flat, value: rupees(55_00_000), asOf: "2025-03-15" });
  recordAdvance(db, ravi, { loanId: h.ammu, amount: rupees(10_000), date: "2025-03-12", fromAccountId: h.bank });
  createTransfer(db, ravi, { fromAccountId: h.bank, toAccountId: h.dues, amount: rupees(20_000), date: "2025-03-20" });
}

describe("NW-1 · a snapshot keeps every group on the statement", () => {
  test("money owed to family and other liabilities are stored", () => {
    const db = freshDb();
    household(db);
    const s = snapshotNetWorth(db, ravi, "2025-03-01");
    assert.equal(s.owed_to_family, rupees(30_000));
    assert.equal(s.other_liabilities, rupees(1_00_000));
    assert.equal(
      s.net_worth,
      s.cash + s.investments + s.other_assets - s.credit_cards - s.loans - s.owed_to_family! - s.other_liabilities!,
    );
  });

  test("and the CSV carries them, last, blank where not recorded", () => {
    const db = freshDb();
    household(db);
    snapshotNetWorth(db, ravi, "2025-03-01");
    execute(db, `INSERT INTO net_worth_snapshots
      (as_of,cash,investments,other_assets,credit_cards,loans,net_worth,created_at)
      VALUES ('2025-01-01',0,0,0,0,0,0,'2025-01-01T00:00:00+05:30')`);
    const [header, old, row] = exportNetWorthCsv(db).trim().split("\n").map((l) => l.split(","));
    assert.deepEqual(header!.slice(-2), ["owed_to_family", "other_liabilities"]);
    assert.deepEqual(old!.slice(-2), ["", ""]);
    assert.deepEqual(row!.slice(-2), ["30000.00", "100000.00"]);
  });
});

describe("NW-1 · the change, when both snapshots recorded everything", () => {
  test("revaluation, family and other liabilities each have a part, and the parts sum", () => {
    const db = freshDb();
    const h = household(db);
    snapshotNetWorth(db, ravi, "2025-03-01");
    march(db, h);
    snapshotNetWorth(db, ravi, "2025-03-31");

    const c = netWorthChange(db, "2025-03-01", "2025-03-31")!;
    // Cash −30,000; flat +5,00,000; owed to family −10,000; dues −20,000.
    assert.equal(c.total, rupees(5_00_000));
    assert.equal(c.moneySaved, -rupees(30_000));
    assert.equal(c.otherAssetsChange, rupees(5_00_000));
    assert.equal(c.owedToFamilyRepaid, rupees(10_000));
    assert.equal(c.otherLiabilitiesRepaid, rupees(20_000));
    assert.equal(c.debtRepaid, 0);
    assert.equal(c.unrecorded, null);
    assert.equal(sumOfParts(c), c.total);
    assert.ok(!c.parts.some((p) => p.key === "unrecorded"));
    assert.match(c.reading, /in other assets/);
    assert.match(c.reading, /less owed to family/);
  });
});

describe("NW-1 · the change, from a snapshot written before they were recorded", () => {
  test("one balancing line, named for when recording began, makes the parts sum", () => {
    const db = freshDb();
    const h = household(db);
    snapshotNetWorth(db, ravi, "2025-03-01");
    // As a snapshot written before 0066 would read.
    execute(db, `UPDATE net_worth_snapshots SET owed_to_family = NULL, other_liabilities = NULL WHERE as_of = '2025-03-01'`);
    march(db, h);
    snapshotNetWorth(db, ravi, "2025-03-31");

    const c = netWorthChange(db, "2025-03-01", "2025-03-31")!;
    assert.equal(c.total, rupees(5_00_000));
    assert.equal(c.owedToFamilyRepaid, null);
    assert.equal(c.otherLiabilitiesRepaid, null);
    // What the two missing parts would have said: ₹10,000 + ₹20,000.
    assert.deepEqual(c.unrecorded, { amount: rupees(30_000), since: "2025-03-31" });
    const other = c.parts.find((p) => p.key === "unrecorded")!;
    assert.equal(other.label, "Other (not recorded before 31-03-2025)");
    assert.equal(sumOfParts(c), c.total);
  });

  test("with no snapshot recorded since, the line still balances", () => {
    const db = freshDb();
    const h = household(db);
    snapshotNetWorth(db, ravi, "2025-03-01");
    march(db, h);
    snapshotNetWorth(db, ravi, "2025-03-31");
    execute(db, `UPDATE net_worth_snapshots SET owed_to_family = NULL, other_liabilities = NULL`);

    const c = netWorthChange(db, "2025-03-01", "2025-03-31")!;
    assert.equal(c.unrecorded!.amount, rupees(30_000));
    assert.equal(c.unrecorded!.since, todayIST());
    assert.equal(sumOfParts(c), c.total);
  });
});

describe("NW-1 · migration 0066 over a database with snapshots in it", () => {
  test("old rows keep their figures with the new columns NULL, and the next change balances", () => {
    const version = MIGRATIONS.findIndex((m) => m.name.startsWith("0066-")) + 1;
    assert.ok(version > 0, "0066 is in the list");

    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    migrate(db, false, version - 1);
    ensureHousehold(db);
    const h = household(db);
    // A snapshot as the app wrote it before 0066: no column for either.
    snapshotOld(db, "2025-03-01");

    migrate(db, false);
    const old = queryOne<Record<string, unknown>>(db, `SELECT * FROM net_worth_snapshots WHERE as_of = '2025-03-01'`)!;
    assert.equal(old.owed_to_family, null);
    assert.equal(old.other_liabilities, null);
    assert.equal(old.net_worth, rupees(54_00_000), "the stored figure is untouched");

    march(db, h);
    snapshotNetWorth(db, ravi, "2025-03-31");
    const c = netWorthChange(db, "2025-03-01", "2025-03-31")!;
    assert.equal(c.total, rupees(5_00_000));
    assert.equal(c.unrecorded!.amount, rupees(30_000));
    assert.equal(sumOfParts(c), c.total);
  });
});

/** The pre-0066 INSERT: every column but the two this batch added. */
function snapshotOld(db: DB, asOf: string) {
  // Bank ₹5,30,000, flat ₹50,00,000; owed ₹30,000 to Ammu and ₹1,00,000 in dues.
  execute(
    db,
    `INSERT INTO net_worth_snapshots
       (as_of,cash,investments,other_assets,credit_cards,loans,net_worth,worst_price_date,created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    asOf, rupees(5_30_000), 0, rupees(50_00_000), 0, 0, rupees(54_00_000), null, "2025-03-01T00:00:00+05:30",
  );
}
