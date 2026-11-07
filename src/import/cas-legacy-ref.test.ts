/**
 * IMP-13 · A row imported before CAS-1 / CAS-2 is not offered again as new.
 *
 * A row's recorded reference hashes its scheme, date, kind, units and amount.
 * CAS-1 (a description ending in a bare number) and CAS-2 (hyphenated
 * Switch-In / Switch-Out) changed how some rows read, so the reference they
 * hash changed too, and a statement imported before those fixes proposed those
 * rows again as new on re-import — a second lot on top of the first.
 *
 * The references below are rebuilt here by hand from the parser as it stood
 * before 3712655 (CAS-1) and 50f6a70 (CAS-2), not from the code under test.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { openDatabase, ensureHousehold, execute, type DB } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST } from "../core/dates.ts";
import {
  createAssetAccount, findOrCreateInstrument, recordPurchase, listHoldings, lotsFor,
} from "../domain/assets.ts";
import { parseCasText } from "./cas.ts";
import { planCasImport, applyCasPlan } from "./cas-plan.ts";
import { renderCasReview } from "../web/pages/portfolio.ts";
import type { Paise } from "../core/money.ts";

const RAVI = "m-ravi";
const actor: Actor = { memberId: RAVI, source: "ui" };
const ISIN = "INF000Z01AB1";

function setup() {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    RAVI, "ravi@example.com", "Ravi", nowIST());
  const account = createAssetAccount(db, actor, {
    name: "Mutual funds", subtype: "investment", openingDate: "2026-01-01",
  });
  const fund = findOrCreateInstrument(db, actor, {
    name: "Fictional Flexi Cap Fund - Direct - Growth", kind: "mutual-fund", isin: ISIN, provider: "manual",
  });
  return { db, accountId: account.id, fundId: fund.id };
}

/** The reference as cas-plan.ts's rowRef has always built it. */
function oldRef(date: string, kind: string, units: number, amount: number, occurrence = 0): string {
  const digest = createHash("sha256")
    .update(`${ISIN}|${date}|${kind}|${units}|${amount}`).digest("hex").slice(0, 16);
  return `cas:${digest}:${occurrence}`;
}

const statement = (...rows: string[]) => parseCasText([
  "Fictional AMC Limited",
  "Folio No: 4242",
  "Fictional Flexi Cap Fund - Direct - Growth",
  `ISIN: ${ISIN}    Registrar : CAMS`,
  ...rows,
].join("\n"));

/** A lot recorded the way the old import recorded it. */
function oldLot(db: DB, accountId: string, fundId: string, date: string, units: number, price: number, ref: string) {
  recordPurchase(db, actor, {
    accountId, instrumentId: fundId, tradeDate: date, price, units, fromAccountId: null, sourceRef: ref,
  });
}

describe("IMP-13 · a CAS-1 row imported before the fix", () => {
  // Read before CAS-1 as ₹3 for 1,000 units at ₹10 (the fallback order, as no
  // pair multiplied to ₹3); read now as ₹1,000 for 10 units at ₹100.
  const row = "07-Apr-2026  SIP Purchase Instalment 3  1,000.00  10.000  100.0000  10.000";
  const legacy = oldRef("2026-04-07", "purchase", 1_000_000, 300);

  test("with the old wrong figures, it is flagged to check — not new, and not imported again", () => {
    const { db, accountId, fundId } = setup();
    oldLot(db, accountId, fundId, "2026-04-07", 1_000_000, 10_000_000, legacy);

    const plan = planCasImport(db, statement(row), accountId);
    const planned = plan.schemes[0]!.rows[0]!;
    assert.equal(planned.status, "check");
    assert.match(planned.note!, /imported earlier with different figures/i);
    assert.equal(plan.totals.newLots, 0);
    assert.equal(plan.totals.toCheck, 1);

    applyCasPlan(db, actor, plan, [0]);
    assert.equal(lotsFor(db, listHoldings(db, accountId)[0]!.id).length, 1, "no second lot");
  });

  test("corrected by hand to the right figures, it is already held", () => {
    const { db, accountId, fundId } = setup();
    oldLot(db, accountId, fundId, "2026-04-07", 10_000, 100_000_000, legacy);

    const plan = planCasImport(db, statement(row), accountId);
    assert.equal(plan.schemes[0]!.rows[0]!.status, "already-held");
    assert.equal(plan.totals.alreadyHeld, 1);
    assert.equal(plan.totals.newLots, 0);
  });
});

describe("IMP-13 · a CAS-2 row imported before the fix", () => {
  test("a Switch-Out the old reading took for a purchase (it says 'Investment') is flagged", () => {
    const { db, accountId, fundId } = setup();
    // Before CAS-2, "Switch-Out" missed /switch\s*out/ and "Investment" hit
    // /invest/: a purchase of +50 units.
    oldLot(db, accountId, fundId, "2026-04-01", 100_000, 100_000_000, oldRef("2026-04-01", "purchase", 100_000, 1_000_000));
    oldLot(db, accountId, fundId, "2026-04-06", 50_000, 100_000_000, oldRef("2026-04-06", "purchase", 50_000, 500_000));

    const plan = planCasImport(db, statement(
      "01-Apr-2026  Purchase  10,000.00  100.000  100.0000  100.000",
      "06-Apr-2026  Switch-Out - To Fictional Investment Fund  (5,000.00)  (50.000)  100.0000  50.000",
    ), accountId);
    assert.deepEqual(plan.schemes[0]!.rows.map((r) => r.status), ["already-held", "check"]);
    assert.equal(plan.schemes[0]!.rows[1]!.row.kind, "redemption");
  });
});

describe("IMP-13 · nothing else changes", () => {
  test("a row matching neither reference is new, and one matching today's is already held", () => {
    const { db, accountId, fundId } = setup();
    oldLot(db, accountId, fundId, "2026-04-01", 100_000, 100_000_000, oldRef("2026-04-01", "purchase", 100_000, 1_000_000));
    const plan = planCasImport(db, statement(
      "01-Apr-2026  Purchase  10,000.00  100.000  100.0000  100.000",
      "07-Apr-2026  SIP Purchase Instalment 3  1,000.00  10.000  100.0000  110.000",
    ), accountId);
    assert.deepEqual(plan.schemes[0]!.rows.map((r) => r.status), ["already-held", "new"]);
    assert.equal(plan.totals.toCheck, 0);
  });
});

describe("IMP-13 · the review screen", () => {
  test("names a row to check, with its note, and counts it apart from the new ones", () => {
    const page = String(renderCasReview({
      period: null, unparsed: [], token: "t",
      totals: { newLots: 0, alreadyHeld: 0, invested: 0 as Paise, toCheck: 1 },
      schemes: [{
        index: 0, name: "Fictional Fund", folio: "1", amc: "A", isin: null, newInstrument: false,
        destination: null, newLots: 0, invested: 0 as Paise, unitsDisagreement: null,
        rows: [{
          date: "2026-04-07", kind: "purchase", description: "SIP Purchase Instalment 3",
          amount: 100_000 as Paise, units: 10_000, nav: 100_000_000, status: "check",
          note: "Imported earlier with different figures — check.",
        }],
      }],
    }));
    assert.match(page, /<span class="chip chip-warning">Check<\/span>/);
    assert.match(page, /1 imported earlier with different figures/);
  });
});
