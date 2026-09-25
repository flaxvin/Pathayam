/**
 * What FIRE takes a year to cost.
 *
 * Two defects in the one number every other FIRE figure is a multiple of:
 *
 * 1. A short history was divided by the full window. Three monthly ₹30,000
 *    grocery bills, with history starting 2026-06-01 and the projection as of
 *    2026-09-01: ₹90,000 over a 365-day window annualised to ₹90,000 a year,
 *    while the screen said the short window had been "scaled up". Scaled by
 *    the 92 days that exist: 90,000 ÷ 92 × 365 = ₹3,57,065.
 *
 * 2. Portfolio purchases counted as living costs. A ₹50,000 monthly SIP paid
 *    from an "Investments" envelope plus ₹30,000 of groceries read as
 *    ₹9,60,000 a year; living costs are ₹3,60,000. At the 3.5% withdrawal rate
 *    that is a FIRE number of ₹2.74 crore against ₹1.03 crore.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute } from "../db/db.ts";
import { nowIST } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import type { Actor } from "../core/events.ts";
import { createAccount } from "./accounts.ts";
import { createGroup, createCategory } from "./budget.ts";
import { createTransaction } from "./transactions.ts";
import { createAssetAccount, findOrCreateInstrument, recordPurchase } from "./assets.ts";
import { price } from "../portfolio/holdings.ts";
import { fireProjection } from "./fire.ts";

const actor: Actor = { memberId: "m", source: "ui" };

function household(openingDate: string) {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    "m", "ravi@example.com", "Ravi", nowIST());
  const bank = createAccount(db, actor, {
    name: "Bank", kind: "budget", subtype: "savings",
    openingDate, openingBalance: rupees(50_00_000),
  }).id;
  const group = createGroup(db, actor, "Living");
  const groceries = createCategory(db, actor, { groupId: group.id, name: "Groceries" }).id;
  const investments = createCategory(db, actor, { groupId: group.id, name: "Investments" }).id;
  return { db, bank, groceries, investments };
}

describe("FIRE's annual spending", () => {
  test("a short history is scaled by the days that exist, not the window", () => {
    const { db, bank, groceries } = household("2026-06-01");
    for (const date of ["2026-06-15", "2026-07-15", "2026-08-15"]) {
      createTransaction(db, actor, {
        accountId: bank, amount: -rupees(30_000), date, categoryId: groceries, cleared: true,
      });
    }
    const p = fireProjection(db, { asOf: "2026-09-01" });
    assert.equal(p.windowIsShort, true);
    // The account opened on 2026-06-01, the start of the history: 92 days.
    assert.equal(p.observedDays, 92);
    assert.equal(p.annualExpenses, Math.round((rupees(90_000) / 92) * 365));
    assert.ok(p.annualExpenses > rupees(350_000), `₹${p.annualExpenses / 100} is not a year of ₹30,000 months`);
  });

  test("a SIP bought through the portfolio is saving, not spending", () => {
    const { db, bank, groceries, investments } = household("2025-01-01");
    const demat = createAssetAccount(db, actor, { name: "Demat", subtype: "investment" }).id;
    const fund = findOrCreateInstrument(db, actor, {
      name: "Fictional Index Fund", kind: "mutual-fund", symbol: "F", provider: "manual",
    }).id;
    // Thirteen months, August 2025 to August 2026, so the trailing year
    // (2025-09-01 to 2026-09-01) holds exactly twelve of each.
    for (let i = 0; i < 13; i++) {
      const y = 2025 + Math.floor((7 + i) / 12);
      const date = `${y}-${String(((7 + i) % 12) + 1).padStart(2, "0")}-10`;
      createTransaction(db, actor, {
        accountId: bank, amount: -rupees(30_000), date, categoryId: groceries, cleared: true,
      });
      recordPurchase(db, actor, {
        accountId: demat, instrumentId: fund, tradeDate: date, price: price(100),
        amount: rupees(50_000), fromAccountId: bank, categoryId: investments,
      });
    }
    const p = fireProjection(db, { asOf: "2026-09-01" });
    assert.equal(p.windowIsShort, false);
    // Twelve ₹30,000 months over the full 365-day window.
    assert.equal(p.annualExpenses, rupees(360_000), "the SIP was counted as living costs");
  });
});
