/**
 * Whose capital gain it is.
 *
 * WEALTH-7 · Income tax is assessed on the person who owns the asset, so a
 * member's estimate takes gains from the accounts they are named holder of —
 * not from every account they can see. A sale in Priya's household-visible
 * demat used to land in Ravi's estimate as well as hers.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { rupees } from "../core/money.ts";
import type { Actor } from "../core/events.ts";
import { createAccount } from "./accounts.ts";
import {
  createAssetAccount, findOrCreateInstrument, recordPurchase, recordSale, listHoldings,
  classifyInstrument,
} from "./assets.ts";
import { units, price } from "../portfolio/holdings.ts";
import { gainsBucketsForYear } from "./capital-gains-tax.ts";
import { freshDb, seedMember } from "../web/harness.test-data.ts";

const ravi: Actor = { memberId: "m", source: "ui" };

/** A ₹5,00,000 short-term equity gain in FY 2025, in a demat held by `holder`. */
function saleIn(db: ReturnType<typeof freshDb>, holder: string | null, name: string) {
  const bank = createAccount(db, ravi, {
    name: `${name} bank`, kind: "budget", subtype: "savings",
    openingDate: "2025-01-01", openingBalance: rupees(1_000_000),
  }).id;
  const demat = createAssetAccount(db, ravi, {
    name, subtype: "investment", holderMemberId: holder, visibility: "household",
  }).id;
  const stock = findOrCreateInstrument(db, ravi, {
    name: `${name} Co`, kind: "equity", symbol: name.toUpperCase().replace(/\W/g, ""), provider: "manual",
  }).id;
  classifyInstrument(db, ravi, stock, { assetClass: "equity" });
  recordPurchase(db, ravi, {
    accountId: demat, instrumentId: stock, tradeDate: "2025-05-01",
    price: price(100), units: units(1_000), fromAccountId: bank,
  });
  recordSale(db, ravi, {
    holdingId: listHoldings(db, demat)[0]!.id, date: "2025-09-01",
    units: units(1_000), price: price(600), toAccountId: bank,
  });
}

describe("WEALTH-7 · a gain belongs to the account's holder", () => {
  test("another member's household-visible demat is not in this member's estimate", () => {
    const db = freshDb();
    seedMember(db, "m", "Ravi");
    seedMember(db, "p", "Priya");
    saleIn(db, "p", "Priya demat");

    assert.equal(gainsBucketsForYear(db, 2025, "m").equityShort, 0, "Priya's sale was taxed in Ravi's estimate");
    assert.equal(gainsBucketsForYear(db, 2025, "p").equityShort, rupees(500_000));
  });

  test("an account with no holder is reported, not taxed on everybody", () => {
    const db = freshDb();
    seedMember(db, "m", "Ravi");
    seedMember(db, "p", "Priya");
    saleIn(db, null, "Joint demat");

    for (const member of ["m", "p"]) {
      const b = gainsBucketsForYear(db, 2025, member);
      assert.equal(b.equityShort, 0);
      assert.equal(b.unclassified, rupees(500_000));
      assert.match(b.unclassifiedReasons[0]!.reason, /names no holder/);
    }
  });

  test("with a single member, an account with no holder is theirs", () => {
    const db = freshDb();
    seedMember(db, "m", "Ravi");
    saleIn(db, null, "Demat");

    const b = gainsBucketsForYear(db, 2025, "m");
    assert.equal(b.equityShort, rupees(500_000));
    assert.equal(b.unclassified, 0);
  });
});
