/**
 * Long-term means held MORE than twelve (or twenty-four) calendar months.
 *
 * The defect: every holding-period test counted days — `> 365` and `> 730` in
 * the tax estimate, `> 365` in the gains report, `>= 365` in the sale preview.
 * Days and months disagree across a leap day. Bought 2024-02-28 and sold
 * 2025-02-28 is 366 days, so all three called it long-term; it is exactly
 * twelve months, which is not "more than twelve", so it is short-term — 111A at
 * 20%, not 112A at 12.5% above ₹1,25,000. On a ₹2,00,000 gain that is ₹40,000
 * of tax, against ₹9,375 (₹75,000 × 12.5%). A day later (2025-03-01) it is
 * long-term.
 *
 * All three now use one helper, `heldMoreThanMonths`, so a parcel cannot be
 * long-term on one screen and short-term on the next.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute } from "../db/db.ts";
import { nowIST, heldMoreThanMonths, daysBetween } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import type { Actor } from "../core/events.ts";
import { createAccount } from "./accounts.ts";
import {
  createAssetAccount, findOrCreateInstrument, recordPurchase, recordSale, listHoldings,
  classifyInstrument,
} from "./assets.ts";
import { units, price, previewSale, makeLot } from "../portfolio/holdings.ts";
import { capitalGainsByYear } from "./reports.ts";
import { gainsBucketsForYear } from "./capital-gains-tax.ts";

const actor: Actor = { memberId: "m", source: "ui" };

describe("heldMoreThanMonths", () => {
  test("exactly twelve months is not more than twelve, even across a leap day", () => {
    assert.equal(daysBetween("2024-02-28", "2025-02-28"), 366, "the fixture must straddle 29 Feb");
    assert.equal(heldMoreThanMonths("2024-02-28", "2025-02-28", 12), false);
    assert.equal(heldMoreThanMonths("2024-02-28", "2025-03-01", 12), true);
  });

  test("a month-end purchase anniversaries on the shorter month's last day", () => {
    // 2024-02-29 + 12 months = 2025-02-28.
    assert.equal(heldMoreThanMonths("2024-02-29", "2025-02-28", 12), false);
    assert.equal(heldMoreThanMonths("2024-02-29", "2025-03-01", 12), true);
  });

  test("twenty-four months for property and gold", () => {
    // 2023-03-01 → 2025-03-01 is 731 days (the 2024 leap day), exactly 24 months.
    assert.equal(daysBetween("2023-03-01", "2025-03-01"), 731);
    assert.equal(heldMoreThanMonths("2023-03-01", "2025-03-01", 24), false);
    assert.equal(heldMoreThanMonths("2023-03-01", "2025-03-02", 24), true);
  });
});

describe("the sale preview says the same", () => {
  test("exactly twelve months is described as not over twelve", () => {
    const holding = {
      lots: [makeLot({ id: "l1", tradeDate: "2024-02-28", amount: rupees(100_000), price: price(100) })],
    };
    const p = previewSale(holding, units(100), price(150), { saleDate: "2025-02-28" });
    // The old `>= 365` test called 366 days "over 12 months".
    assert.match(p.description, /All lots held 12 months or less/);
  });
});

describe("the tax buckets and the gains report agree", () => {
  test("a lot bought 2024-02-28 and sold 2025-02-28 is short-term in both", () => {
    const db = openDatabase({ path: ":memory:", verbose: false });
    ensureHousehold(db);
    execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
      "m", "f@e.com", "Ravi", nowIST());
    const bank = createAccount(db, actor, {
      name: "Savings", kind: "budget", subtype: "savings",
      openingDate: "2020-01-01", openingBalance: rupees(1_000_000),
    }).id;
    const demat = createAssetAccount(db, actor, { name: "Demat", subtype: "investment" }).id;
    const fund = findOrCreateInstrument(db, actor, {
      name: "Index Fund", kind: "mutual-fund", symbol: "1", provider: "manual",
    }).id;
    classifyInstrument(db, actor, fund, { assetClass: "equity" });

    // ₹1,00,000 in at ₹100; out at ₹300 — a ₹2,00,000 gain.
    recordPurchase(db, actor, {
      accountId: demat, instrumentId: fund, tradeDate: "2024-02-28",
      price: price(100), units: units(1_000), fromAccountId: bank,
    });
    const holding = listHoldings(db, demat)[0]!;
    recordSale(db, actor, {
      holdingId: holding.id, date: "2025-02-28",
      units: units(1_000), price: price(300), toAccountId: bank,
    });

    const b = gainsBucketsForYear(db, 2024, "m");
    assert.equal(b.equityShort, rupees(200_000), "exactly twelve months is 111A");
    assert.equal(b.equityLong, 0, "it was filed as 112A on a 366-day count");

    const report = capitalGainsByYear(db).find((y) => y.fy === 2024)!;
    assert.equal(report.parcels[0]!.longTerm, false);
    assert.equal(report.shortTerm, rupees(200_000));
  });
});
