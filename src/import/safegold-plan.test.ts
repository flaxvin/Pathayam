/**
 * IMP-31 · Importing a SafeGold statement into the portfolio.
 *
 * As a CAS does for funds: gold is an instrument (its unit the milligram), a
 * purchase is a lot whose cost is the amount the statement says was paid —
 * GST included, capitalised like any other purchase charge (R24.5) — and a
 * sale realises a gain against those lots by FIFO. Gold is not equity, so the
 * gain follows the rule already there for gold: long-term after 24 months,
 * then 12.5% under s112. A re-issued statement adds nothing twice, a statement
 * whose closing balance its rows do not reach is refused, and the whole
 * import undoes as one action.
 *
 * Every figure here is synthetic.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, queryAll } from "../db/db.ts";
import { undoEvent, type Actor } from "../core/events.ts";
import { nowIST } from "../core/dates.ts";
import {
  createAssetAccount, listHoldings, lotsFor, getInstrument, recordPurchase, listAssetAccounts,
} from "../domain/assets.ts";
import { gainsBucketsForYear } from "../domain/capital-gains-tax.ts";
import { Refusal } from "../core/refusal.ts";
import { parseSafeGoldText, SAFEGOLD_INSTRUMENT } from "./safegold.ts";
import { planSafeGoldImport, applySafeGoldPlan } from "./safegold-plan.ts";
import { statement, TWO_ROWS } from "./safegold.test-data.ts";

const RAVI = "m-ravi";
const actor: Actor = { memberId: RAVI, source: "ui" };

function setup() {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    RAVI, "ravi@example.com", "Ravi", nowIST());
  return db;
}

/** The fixture opens at 1 g; this statement opens at nothing, so its rows are all there is. */
const fromNothing = (rows: string[], closing: string) =>
  parseSafeGoldText(statement(rows, closing)
    .replace(/(Opening Gold Wallet Balance as of 1st October 2026 :\s+)1\.0000/, "$10.0000")
    .replace(/(1st October 2026   )1\.0000/, "$10.0000"));

const BUY_AND_SELL = fromNothing([
  "05 Oct 2026     Gold Purchased                                  0.7000 g          0.7000 g",
  "10:15 AM        Rate ₹10,000.00/g  Amount ₹7,210.00 (incl. GST ₹210.00)",
  "20 Oct 2026     Gold Sold                                       0.2000 g          0.5000 g",
  "04:30 PM        Rate ₹10,500.00/g  Amount ₹2,100.00",
], "0.5000");

function eventsOf(db: ReturnType<typeof setup>, action: string) {
  return queryAll<{ id: string }>(db, `SELECT id FROM events WHERE action = ? ORDER BY seq`, action);
}

describe("IMP-31 · a purchase is a lot, a sale realises a gain", () => {
  test("the first import makes the gold instrument and a commodity account for it", () => {
    const db = setup();
    const plan = planSafeGoldImport(db, [BUY_AND_SELL], RAVI);
    assert.equal(plan.newAccount, true);
    assert.equal(plan.totals.newEntries, 2);
    assert.equal(plan.totals.invested, 721_000);

    const result = applySafeGoldPlan(db, actor, plan);
    assert.deepEqual({ lots: result.lots, sales: result.sales }, { lots: 1, sales: 1 });

    const account = listAssetAccounts(db).find((a) => a.subtype === "commodity")!;
    assert.ok(account, "a commodity account");
    const holding = listHoldings(db, account.id)[0]!;
    const instrument = getInstrument(db, holding.instrument_id)!;
    assert.equal(instrument.name, SAFEGOLD_INSTRUMENT);
    assert.equal(instrument.kind, "commodity");
    assert.equal(instrument.asset_class, "gold");

    // 0.7 g bought for ₹7,210 with its GST; 0.2 g of it sold, FIFO.
    const [lot] = lotsFor(db, holding.id);
    assert.equal(lot!.units, 500_000);
    assert.equal(lot!.price, 10_000_000);
    // What is left carries five sevenths of the cost, GST included.
    assert.equal(lot!.cost, 515_000);

    const [sale] = queryAll<{ units: number; amount: number; realised_gain: number }>(
      db, `SELECT units, amount, realised_gain FROM holding_events WHERE holding_id = ? AND kind = 'sale'`, holding.id,
    );
    assert.equal(sale!.units, 200_000);
    assert.equal(sale!.amount, 210_000);
    // ₹2,100 for gold that cost ₹2,060 with its GST.
    assert.equal(sale!.realised_gain, 4_000);
  });

  test("gold held over 24 months is long-term, under s112", () => {
    const db = setup();
    const early = fromNothing([
      "01 Aug 2024     Gold Purchased     Rate ₹7,000.00/g  Amount ₹7,000.00  1.0000 g  1.0000 g",
    ], "1.0000");
    early.period = { from: "2024-08-01", to: "2024-08-31" };
    applySafeGoldPlan(db, actor, planSafeGoldImport(db, [early], RAVI));
    const later = parseSafeGoldText(statement([
      "05 Oct 2026     Gold Sold      Rate ₹10,000.00/g  Amount ₹5,000.00   0.5000 g   0.5000 g",
    ], "0.5000"));
    applySafeGoldPlan(db, actor, planSafeGoldImport(db, [later], RAVI));
    const buckets = gainsBucketsForYear(db, 2026, RAVI);
    // ₹5,000 for 0.5 g that cost ₹3,500, held more than 24 months.
    assert.equal(buckets.otherLong, 150_000);
    assert.equal(buckets.slabRated, 0);
    assert.equal(buckets.unclassified, 0);
  });

  test("held under 24 months, the gain is slab-rated", () => {
    const db = setup();
    applySafeGoldPlan(db, actor, planSafeGoldImport(db, [BUY_AND_SELL], RAVI));
    const buckets = gainsBucketsForYear(db, 2026, RAVI);
    assert.equal(buckets.slabRated, 4_000);
    assert.equal(buckets.otherLong, 0);
  });

  test("it lands in the household's one commodity account when there is one", () => {
    const db = setup();
    const gold = createAssetAccount(db, actor, { name: "Gold", subtype: "commodity" });
    const plan = planSafeGoldImport(db, [BUY_AND_SELL], RAVI);
    assert.equal(plan.accountId, gold.id);
    assert.equal(plan.newAccount, false);
  });
});

describe("IMP-31 · a statement is imported once", () => {
  test("the same statement again adds nothing", () => {
    const db = setup();
    applySafeGoldPlan(db, actor, planSafeGoldImport(db, [BUY_AND_SELL], RAVI));
    const again = planSafeGoldImport(db, [BUY_AND_SELL], RAVI);
    assert.equal(again.totals.newEntries, 0);
    assert.equal(again.totals.alreadyHeld, 2);
    const result = applySafeGoldPlan(db, actor, again);
    assert.deepEqual({ lots: result.lots, sales: result.sales }, { lots: 0, sales: 0 });
    assert.equal(queryAll(db, `SELECT id FROM lots`).length, 1);
    assert.equal(queryAll(db, `SELECT id FROM holding_events`).length, 1);
  });

  test("REV-2 · two plans read from one statement, both confirmed, record it once", () => {
    // A Gmail fetch and an upload of the same month, both reviewed before
    // either is confirmed: each plan marks every row new.
    const db = setup();
    const a = planSafeGoldImport(db, [BUY_AND_SELL], RAVI);
    const b = planSafeGoldImport(db, [BUY_AND_SELL], RAVI);
    assert.equal(b.totals.newEntries, 2);
    applySafeGoldPlan(db, actor, a);
    const result = applySafeGoldPlan(db, actor, b);
    assert.deepEqual({ lots: result.lots, sales: result.sales }, { lots: 0, sales: 0 });
    assert.equal(queryAll(db, `SELECT id FROM lots`).length, 1);
    assert.equal(queryAll(db, `SELECT id FROM holding_events`).length, 1);
    assert.equal(listAssetAccounts(db).length, 1, "no second SafeGold account");
    assert.equal(eventsOf(db, "safegold-import").length, 1);
  });

  test("two identical purchases on one statement both count", () => {
    const db = setup();
    const twice = fromNothing([
      "05 Oct 2026     Gold Purchased     Rate ₹10,000.00/g  Amount ₹1,000.00  0.1000 g  0.1000 g",
      "05 Oct 2026     Gold Purchased     Rate ₹10,000.00/g  Amount ₹1,000.00  0.1000 g  0.2000 g",
    ], "0.2000");
    const plan = planSafeGoldImport(db, [twice], RAVI);
    assert.equal(plan.totals.newEntries, 2);
    applySafeGoldPlan(db, actor, plan);
    assert.equal(planSafeGoldImport(db, [twice], RAVI).totals.newEntries, 0);
  });
});

describe("IMP-31 · a closing balance its rows do not reach", () => {
  const missing = fromNothing([
    "05 Oct 2026     Gold Purchased     Rate ₹10,000.00/g  Amount ₹1,000.00  0.1000 g  0.1000 g",
  ], "0.3000");

  test("is flagged on the plan and refused on confirmation", () => {
    const db = setup();
    const plan = planSafeGoldImport(db, [missing], RAVI);
    assert.equal(plan.statements[0]!.disagreement, 200_000);
    assert.throws(() => applySafeGoldPlan(db, actor, plan), Refusal);
    assert.equal(queryAll(db, `SELECT id FROM lots`).length, 0);
  });

  test("unless the person says to import it anyway", () => {
    const db = setup();
    const plan = planSafeGoldImport(db, [missing], RAVI);
    assert.equal(applySafeGoldPlan(db, actor, plan, { acceptMismatch: true }).lots, 1);
  });

  test("a sale of more gold than is recorded is refused, by name", () => {
    const db = setup();
    const sale = parseSafeGoldText(statement([
      "05 Oct 2026     Gold Sold      Rate ₹10,000.00/g  Amount ₹5,000.00   0.5000 g   0.5000 g",
    ], "0.5000"));
    const plan = planSafeGoldImport(db, [sale], RAVI);
    // The statement opens at 1 g the ledger has never seen, so after it the
    // portfolio would hold 1 g less than the statement closes at.
    assert.equal(plan.ledgerGap, 1_000_000);
    assert.throws(() => applySafeGoldPlan(db, actor, plan), /only 0\.0000 g are recorded/);
  });
});

describe("IMP-31 · the import undoes as one action", () => {
  test("its lots and its sale go, and the statement can be imported again", () => {
    const db = setup();
    applySafeGoldPlan(db, actor, planSafeGoldImport(db, [BUY_AND_SELL], RAVI));
    const [imported] = eventsOf(db, "safegold-import");
    assert.ok(imported);
    const undone = undoEvent(db, imported.id, actor);
    assert.equal(undone.ok, true, undone.reason);
    assert.equal(queryAll(db, `SELECT id FROM lots`).length, 0);
    assert.equal(queryAll(db, `SELECT id FROM holding_events`).length, 0);
    assert.equal(planSafeGoldImport(db, [BUY_AND_SELL], RAVI).totals.newEntries, 2);
  });

  test("lots a sale in it shrank are put back as they were", () => {
    const db = setup();
    applySafeGoldPlan(db, actor, planSafeGoldImport(db, [fromNothing([
      "01 Sep 2026     Gold Purchased     Rate ₹10,000.00/g  Amount ₹10,000.00  1.0000 g  1.0000 g",
    ], "1.0000")], RAVI));
    const sale = parseSafeGoldText(statement([
      "05 Oct 2026     Gold Sold      Rate ₹11,000.00/g  Amount ₹5,500.00   0.5000 g   0.5000 g",
    ], "0.5000"));
    applySafeGoldPlan(db, actor, planSafeGoldImport(db, [sale], RAVI));
    const events = eventsOf(db, "safegold-import");
    assert.equal(undoEvent(db, events[1]!.id, actor).ok, true);
    const holding = listHoldings(db)[0]!;
    const lots = lotsFor(db, holding.id);
    assert.equal(lots.length, 1);
    assert.equal(lots[0]!.units, 1_000_000);
    assert.equal(lots[0]!.cost, 1_000_000);
    assert.equal(queryAll(db, `SELECT id FROM holding_events`).length, 0);
  });

  test("is refused once the holding has changed since", () => {
    const db = setup();
    applySafeGoldPlan(db, actor, planSafeGoldImport(db, [BUY_AND_SELL], RAVI));
    const holding = listHoldings(db)[0]!;
    recordPurchase(db, actor, {
      accountId: holding.account_id, instrumentId: holding.instrument_id,
      tradeDate: "2026-11-01", price: 10_000_000, units: 100_000,
    });
    const [imported] = eventsOf(db, "safegold-import");
    assert.throws(() => undoEvent(db, imported!.id, actor, { force: true }), /changed since/);
    assert.equal(lotsFor(db, holding.id).length, 2);
  });
});
