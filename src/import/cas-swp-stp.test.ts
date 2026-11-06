/**
 * IMP-14 · Systematic withdrawals and systematic transfers in a CAS.
 *
 * "Systematic Withdrawal" / "SWP" rows and "STP Out" / "STP In" /
 * "Systematic Transfer" rows matched none of classify's patterns and were
 * read as "other", so the plan skipped them: an SWP's units were never sold,
 * and an STP never left the source fund or arrived in the target. An SWP is
 * a redemption; an STP Out and STP In are a switch out and in (as CAS-2 made
 * a hyphenated Switch-Out / Switch-In), and a "Systematic Transfer" with no
 * direction goes by the sign of its units.
 *
 * Every row here is synthetic.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { openDatabase, ensureHousehold, execute } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST } from "../core/dates.ts";
import { createAssetAccount, findOrCreateInstrument, recordPurchase, listHoldings } from "../domain/assets.ts";
import { totalUnits } from "../portfolio/holdings.ts";
import { holdingOf } from "../domain/assets.ts";
import { parseCasText } from "./cas.ts";
import { planCasImport, applyCasPlan } from "./cas-plan.ts";

const ISIN = "INF000Z01ZZ9";
const rowsOf = (...rows: string[]) => parseCasText([
  "Folio No: 1234/56",
  "Zeta Flexi Cap Fund - Direct Plan - Growth",
  `ISIN: ${ISIN}`,
  ...rows,
].join("\n")).schemes[0]!.rows;
const one = (row: string) => rowsOf(row)[0]!;

describe("IMP-14 · a systematic withdrawal is a redemption", () => {
  for (const description of [
    "Systematic Withdrawal",
    "Systematic Withdrawal Plan - Instalment",
    "SWP",
    "SWP - Zeta Flexi Cap Fund",
    "Sys. Withdrawal",
  ]) {
    test(`"${description}"`, () => {
      const row = one(`10-May-2026  ${description}  (2,000.00)  (20.000)  100.0000  80.000`);
      assert.equal(row.kind, "redemption");
      assert.equal(row.units, -20_000);
      assert.equal(row.amount, -200_000);
    });
  }

  test("even when its figures are printed without brackets", () => {
    const row = one("10-May-2026  Systematic Withdrawal  2,000.00  20.000  100.0000  80.000");
    assert.equal(row.kind, "redemption");
    assert.equal(row.units, -20_000);
  });
});

describe("IMP-14 · a systematic transfer is a switch", () => {
  for (const description of [
    "STP Out - To Eta Fund",
    "STP-Out - To Eta Fund",
    "STP - Out",
    "Systematic Transfer Out - To Eta Fund",
    // Before IMP-14 /invest/ read this as a purchase.
    "STP Out - To Eta Investment Fund",
    // And /dividend/ this as a payout.
    "STP Out - To Eta Dividend Yield Fund",
  ]) {
    test(`"${description}" is a redemption`, () => {
      const row = one(`12-May-2026  ${description}  (1,000.00)  (10.000)  100.0000  90.000`);
      assert.equal(row.kind, "redemption");
      assert.equal(row.units, -10_000);
    });
  }

  for (const description of [
    "STP In - From Zeta Liquid Fund",
    "STP-In - From Zeta Liquid Fund",
    "STP - In",
    "Systematic Transfer In - From Zeta Liquid Fund",
  ]) {
    test(`"${description}" is a purchase`, () => {
      const row = one(`12-May-2026  ${description}  1,000.00  10.000  100.0000  110.000`);
      assert.equal(row.kind, "purchase");
      assert.equal(row.units, 10_000);
    });
  }

  test("'Systematic Transfer' with no direction goes by the sign of its units", () => {
    const out = one("12-May-2026  Systematic Transfer - Zeta Liquid Fund  (1,000.00)  (10.000)  100.0000  90.000");
    assert.equal(out.kind, "redemption");
    assert.equal(out.units, -10_000);
    const into = one("12-May-2026  Systematic Transfer Plan  1,000.00  10.000  100.0000  110.000");
    assert.equal(into.kind, "purchase");
  });

  test("a reversed STP is still shown, not imported", () => {
    assert.equal(one("12-May-2026  STP Out Reversal  1,000.00  10.000  100.0000  100.000").kind, "other");
  });

  test("an SIP is still a purchase", () => {
    assert.equal(one("01-May-2026  Systematic Investment Purchase  1,000.00  10.000  100.0000  10.000").kind, "purchase");
  });
});

describe("IMP-14 · importing them", () => {
  const actor: Actor = { memberId: "m", source: "ui" };
  function setup() {
    const db = openDatabase({ path: ":memory:", verbose: false });
    ensureHousehold(db);
    execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`, "m", "r@example.com", "Ravi", nowIST());
    const account = createAssetAccount(db, actor, { name: "Mutual funds", subtype: "investment", openingDate: "2026-01-01" });
    return { db, accountId: account.id };
  }

  test("an SWP and an STP Out sell units; an STP In buys them", () => {
    const { db, accountId } = setup();
    const statement = parseCasText([
      "Folio No: 1234/56",
      "Zeta Flexi Cap Fund - Direct Plan - Growth",
      `ISIN: ${ISIN}`,
      "01-Apr-2026  Purchase  10,000.00  100.000  100.0000  100.000",
      "12-Apr-2026  STP In - From Zeta Liquid Fund  1,000.00  10.000  100.0000  110.000",
      "10-May-2026  Systematic Withdrawal  (2,000.00)  (20.000)  100.0000  90.000",
      "12-May-2026  STP Out - To Eta Fund  (1,000.00)  (10.000)  100.0000  80.000",
      "Closing Unit Balance: 80.000",
    ].join("\n"));
    const plan = planCasImport(db, statement, accountId);
    assert.deepEqual(plan.schemes[0]!.rows.map((r) => r.status), ["new", "new", "new", "new"]);
    assert.equal(plan.schemes[0]!.unitsDisagreement, null);

    const result = applyCasPlan(db, actor, plan, [0]);
    assert.equal(result.lots, 2);
    assert.equal(result.sales, 2);
    assert.equal(totalUnits(holdingOf(db, listHoldings(db, accountId)[0]!.id)), 80_000);
  });

  test("an STP Out an earlier import recorded as a purchase is flagged to check, not added again", () => {
    const { db, accountId } = setup();
    const fund = findOrCreateInstrument(db, actor, {
      name: "Zeta Flexi Cap Fund - Direct Plan - Growth", kind: "mutual-fund", isin: ISIN, provider: "manual",
    }).id;
    const ref = (date: string, kind: string, units: number, amount: number) =>
      `cas:${createHash("sha256").update(`${ISIN}|${date}|${kind}|${units}|${amount}`).digest("hex").slice(0, 16)}:0`;
    recordPurchase(db, actor, {
      accountId, instrumentId: fund, tradeDate: "2026-04-01", price: 100_000_000, units: 100_000,
      fromAccountId: null, sourceRef: ref("2026-04-01", "purchase", 100_000, 1_000_000),
    });
    // Read before IMP-14 (and after CAS-2) as a purchase of +10 units, because of "Investment".
    recordPurchase(db, actor, {
      accountId, instrumentId: fund, tradeDate: "2026-05-12", price: 100_000_000, units: 10_000,
      fromAccountId: null, sourceRef: ref("2026-05-12", "purchase", 10_000, 100_000),
    });
    const plan = planCasImport(db, parseCasText([
      "Folio No: 1234/56",
      "Zeta Flexi Cap Fund - Direct Plan - Growth",
      `ISIN: ${ISIN}`,
      "01-Apr-2026  Purchase  10,000.00  100.000  100.0000  100.000",
      "12-May-2026  STP Out - To Eta Investment Fund  (1,000.00)  (10.000)  100.0000  90.000",
    ].join("\n")), accountId);
    assert.deepEqual(plan.schemes[0]!.rows.map((r) => r.status), ["already-held", "check"]);
  });
});

describe("IMP-16 · a switch into or out of a dividend-named fund is a switch", () => {
  test('"Switch-Out - To Eta Dividend Yield Fund" is a redemption', () => {
    const row = one("14-May-2026  Switch-Out - To Eta Dividend Yield Fund  (1,000.00)  (10.000)  100.0000  80.000");
    assert.equal(row.kind, "redemption");
    assert.equal(row.units, -10_000);
  });
  test('"Switch In - From Eta Dividend Yield Fund" is a purchase', () => {
    const row = one("15-May-2026  Switch In - From Eta Dividend Yield Fund  1,000.00  10.000  100.0000  90.000");
    assert.equal(row.kind, "purchase");
    assert.equal(row.units, 10_000);
  });
  test("a real IDCW payout is still a dividend", () => {
    const row = one("16-May-2026  IDCW Payout  500.00  0.000  0.0000  80.000");
    assert.equal(row.kind, "dividend");
  });
});
