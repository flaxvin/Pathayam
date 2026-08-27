import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, type DB } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST } from "../core/dates.ts";
import { createAssetAccount, listHoldings, lotsFor, listInstruments } from "../domain/assets.ts";
import { parseCasPdf, parseCasText, unitsDisagreement } from "./cas.ts";
import { planCasImport, applyCasPlan } from "./cas-plan.ts";
import { FIXTURES, CAS_PASSWORD } from "../pdf/fixtures.test-data.ts";

const RAVI = "m-ravi";
const actor: Actor = { memberId: RAVI, source: "ui" };

function setup() {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    RAVI, "ravi@example.com", "Ravi", nowIST());
  const account = createAssetAccount(db, actor, {
    name: "Mutual funds", subtype: "investment", openingDate: "2026-04-01",
  });
  return { db, account };
}

function statement(db: DB, accountId: string) {
  return planCasImport(db, parseCasPdf(FIXTURES.aes_256, CAS_PASSWORD), accountId);
}

describe("07 F19.14 · reading a CAS", () => {
  test("finds every folio, scheme and identifier", () => {
    const cas = parseCasPdf(FIXTURES.aes_256, CAS_PASSWORD);

    assert.deepEqual(cas.period, { from: "2026-04-01", to: "2026-07-31" });
    assert.equal(cas.schemes.length, 2);

    const [hdfc, icici] = cas.schemes;
    assert.equal(hdfc!.folio, "12345678 / 90");
    assert.equal(hdfc!.isin, "INF179K01XQ0");
    assert.equal(hdfc!.registrar, "CAMS");
    assert.match(hdfc!.amc, /HDFC Asset Management/);

    assert.equal(icici!.folio, "99887766");
    assert.equal(icici!.isin, "INF109K01BL4");
    assert.equal(icici!.registrar, "KFINTECH");
  });

  test("IL3 · nothing that looked like a row is silently dropped", () => {
    assert.deepEqual(parseCasPdf(FIXTURES.aes_256, CAS_PASSWORD).unparsed, []);
  });

  test("R24.3 · units to three decimals, prices in micro-rupees", () => {
    const [hdfc] = parseCasPdf(FIXTURES.aes_256, CAS_PASSWORD).schemes;
    assert.deepEqual(
      hdfc!.rows.map((r) => [r.date, r.kind, r.amount, r.units, r.nav]),
      [
        ["2026-04-05", "purchase", 2_500_000, 312_500, 80_000_000],
        ["2026-05-12", "purchase", 2_500_000, 303_030, 82_500_000],
        ["2026-06-20", "purchase", 2_600_000, 320_513, 81_120_000],
      ],
    );
  });

  test("the closing balance reconciles, and matches 07 §10 as errata E13 corrects it", () => {
    const [hdfc] = parseCasPdf(FIXTURES.aes_256, CAS_PASSWORD).schemes;
    // 936.043 units, not 936.043123… — R24.3 governs, per E13.
    assert.equal(hdfc!.closingUnits, 936_043);
    assert.equal(hdfc!.closingValue, 8_087_412); // ₹80,874.12
    assert.equal(unitsDisagreement(hdfc!), null);
  });

  test("a redemption is negative even when the statement brackets it", () => {
    const [, icici] = parseCasPdf(FIXTURES.aes_256, CAS_PASSWORD).schemes;
    const sale = icici!.rows.find((r) => r.kind === "redemption");
    assert.ok(sale);
    assert.equal(sale!.units, -100_000);
    assert.equal(sale!.amount, -1_100_000);
    assert.equal(unitsDisagreement(icici!), null);
  });
});

describe("07 F19.14 · the text parser on shapes the fixture does not cover", () => {
  test("dd/mm/yyyy dates, and an unbracketed redemption", () => {
    const cas = parseCasText(`
Statement Period: 01/04/2026 To 31/07/2026
Axis Asset Management Company Limited
Folio No: 55554444
Axis Bluechip Fund - Direct Plan - Growth
ISIN: INF846K01131    Registrar : KFINTECH
01/05/2026  Purchase  10,000.00  200.000  50.0000  200.000
01/06/2026  Redemption  5,500.00  100.000  55.0000  100.000
Closing Unit Balance: 100.000
`);
    const [scheme] = cas.schemes;
    assert.equal(scheme!.folio, "55554444");
    assert.equal(scheme!.rows[1]!.units, -100_000, "the word, not the brackets, decides the sign");
    assert.equal(unitsDisagreement(scheme!), null);
  });

  test("R27.5 · a dividend payout carries no units", () => {
    const cas = parseCasText(`
Folio No: 1111
Some Fund - IDCW Option
ISIN: INF846K01131
01/05/2026  Purchase  10,000.00  200.000  50.0000  200.000
15/06/2026  Dividend Payout  350.00  0.000  0.0000  200.000
Closing Unit Balance: 200.000
`);
    const payout = cas.schemes[0]!.rows.find((r) => r.kind === "dividend");
    assert.equal(payout!.units, 0);
    assert.equal(payout!.amount, 35_000);
  });

  test("dividend *reinvestment* is a purchase, not a payout", () => {
    // Getting this backwards would leave the units unrecorded and the cost
    // basis wrong for every subsequent FIFO sale.
    const cas = parseCasText(`
Folio No: 2222
Some Fund - IDCW Reinvestment
ISIN: INF846K01131
15/06/2026  Dividend Reinvestment  350.00  7.000  50.0000  207.000
`);
    assert.equal(cas.schemes[0]!.rows[0]!.kind, "purchase");
    assert.equal(cas.schemes[0]!.rows[0]!.units, 7_000);
  });

  test("a missed row shows up as a disagreement rather than a wrong holding", () => {
    const cas = parseCasText(`
Folio No: 3333
Some Fund - Growth
ISIN: INF846K01131
01/05/2026  Purchase  10,000.00  200.000  50.0000  200.000
Closing Unit Balance: 350.000
`);
    // N9: the statement says 350, the rows say 200. Say so; do not average it.
    assert.equal(unitsDisagreement(cas.schemes[0]!), 150_000);
  });
});

describe("09 §6.2 · a CAS reconciles rather than duplicating", () => {
  test("the first import proposes every row as new", () => {
    const { db, account } = setup();
    const plan = statement(db, account.id);

    assert.equal(plan.totals.newLots, 5);
    assert.equal(plan.totals.alreadyHeld, 0);
    assert.ok(plan.schemes.every((s) => s.newInstrument), "nothing is held yet");
    db.close();
  });

  test("importing the same statement twice adds nothing the second time", () => {
    const { db, account } = setup();

    const first = applyCasPlan(db, actor, statement(db, account.id), [0, 1]);
    assert.equal(first.lots, 4);
    assert.equal(first.sales, 1);
    assert.equal(first.instruments, 2);

    // This is the failure the whole module exists to prevent: a CAS restates
    // months already imported, and the naive path doubles the portfolio.
    const again = statement(db, account.id);
    assert.equal(again.totals.newLots, 0, "every purchase is already held");
    assert.ok(again.schemes.every((s) => !s.newInstrument), "matched on ISIN");

    const second = applyCasPlan(db, actor, again, [0, 1]);
    assert.equal(second.lots, 0);
    assert.equal(second.instruments, 0);

    const holdings = listHoldings(db);
    assert.equal(holdings.length, 2);
    assert.equal(listInstruments(db).length, 2);
    db.close();
  });

  test("units land as the statement stated them", () => {
    const { db, account } = setup();
    applyCasPlan(db, actor, statement(db, account.id), [0, 1]);

    const instrument = listInstruments(db).find((i) => i.isin === "INF179K01XQ0")!;
    const holding = listHoldings(db).find((h) => h.instrument_id === instrument.id)!;
    const lots = lotsFor(db, holding.id);

    assert.equal(lots.length, 3, "R25.1 — one lot per purchase, never merged");
    assert.equal(lots.reduce((sum, l) => sum + l.units, 0), 936_043);
    db.close();
  });

  test("a later statement adds only its new rows", () => {
    const { db, account } = setup();
    applyCasPlan(db, actor, statement(db, account.id), [0, 1]);

    // Next month's CAS: the same three HDFC purchases, plus one more.
    const next = parseCasText(`
Statement Period: 01/04/2026 To 31/08/2026
HDFC Asset Management Company Limited
Folio No: 12345678 / 90
HDFC Liquid Fund - Direct Plan - Growth Option
ISIN: INF179K01XQ0    Registrar : CAMS
05-Apr-2026  Purchase  25,000.00  312.500  80.0000  312.500
12-May-2026  Purchase  25,000.00  303.030  82.5000  615.530
20-Jun-2026  Purchase  26,000.00  320.513  81.1200  936.043
14-Aug-2026  Purchase  25,000.00  289.352  86.4000  1225.395
Closing Unit Balance: 1225.395
`);

    const plan = planCasImport(db, next, account.id);
    assert.equal(plan.totals.newLots, 1);
    assert.equal(plan.totals.alreadyHeld, 3);
    assert.equal(plan.schemes[0]!.newInstrument, false);

    applyCasPlan(db, actor, plan, [0]);

    const instrument = listInstruments(db).find((i) => i.isin === "INF179K01XQ0")!;
    const holding = listHoldings(db).find((h) => h.instrument_id === instrument.id)!;
    assert.equal(lotsFor(db, holding.id).length, 4);
    db.close();
  });

  test("two identical instalments on the same date both survive", () => {
    // D2's instinct, applied to units: a lot may only be matched once, or the
    // second of two identical SIP rows would be swallowed as a duplicate.
    const { db, account } = setup();
    const twice = parseCasText(`
Folio No: 7777
Some Fund - Growth
ISIN: INF846K01131
01/05/2026  Purchase  5,000.00  100.000  50.0000  100.000
01/05/2026  Purchase  5,000.00  100.000  50.0000  200.000
Closing Unit Balance: 200.000
`);

    applyCasPlan(db, actor, planCasImport(db, twice, account.id), [0]);
    const holding = listHoldings(db)[0]!;
    assert.equal(lotsFor(db, holding.id).length, 2);

    // And re-importing that statement still adds neither of them.
    const replan = planCasImport(db, twice, account.id);
    assert.equal(replan.totals.newLots, 0);
    assert.equal(replan.totals.alreadyHeld, 2);
    db.close();
  });

  test("a scheme can be left out of the import", () => {
    const { db, account } = setup();
    applyCasPlan(db, actor, statement(db, account.id), [0]);

    assert.equal(listInstruments(db).length, 1, "only the confirmed scheme was written");
    db.close();
  });

  test("FW4 · importing a CAS creates no budget transaction", () => {
    const { db, account } = setup();
    applyCasPlan(db, actor, statement(db, account.id), [0, 1]);

    // The money left the bank months ago and is already in the ledger from the
    // statement import. Creating a transfer here would double-count it.
    const count = db
      .prepare(`SELECT COUNT(*) AS n FROM transactions`)
      .get() as { n: number };
    assert.equal(count.n, 0);
    db.close();
  });
});
