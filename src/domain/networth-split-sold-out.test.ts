/**
 * DEBUG-ASSETS-2 · A holding sold out before a split keeps its past worth.
 *
 * A split or bonus happens to the instrument: recordSplit adjusts every
 * holding that still has lots, and divides the instrument's price history
 * once. A holding already sold out has no lots, so it gets no event — and
 * holdingValueOn scaled its sale parcels only by the splits recorded against
 * that holding. Ten shares sold in March from one demat, while the same share
 * split 2-for-1 in May in another, were valued in February's snapshot at ten
 * units times the halved price: ₹500 where ₹1,000 was held.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { rupees } from "../core/money.ts";
import type { Actor } from "../core/events.ts";
import {
  createAssetAccount, findOrCreateInstrument, recordPurchase, recordPrice,
  recordSale, recordSplit, listHoldings, holdingValueOn,
} from "./assets.ts";
import { netWorthStatement } from "./networth.ts";
import { price, units } from "../portfolio/holdings.ts";
import { freshDb, seedMember } from "../web/harness.test-data.ts";

const actor: Actor = { memberId: "m", source: "ui" };

for (const kind of ["split", "bonus"] as const) {
  test(`a ${kind} recorded on another holding does not halve a sold-out holding's past value`, () => {
    const db = freshDb();
    seedMember(db, "m", "Ravi");
    const a = createAssetAccount(db, actor, { name: "Demat A", subtype: "investment", asOf: "2025-01-01" }).id;
    const b = createAssetAccount(db, actor, { name: "Demat B", subtype: "investment", asOf: "2025-01-01" }).id;
    const inst = findOrCreateInstrument(db, actor, { name: "Fictional Co", kind: "equity", provider: "manual" });
    for (const account of [a, b]) {
      recordPurchase(db, actor, {
        accountId: account, instrumentId: inst.id, tradeDate: "2025-01-10",
        price: price(100), units: units(10),
      });
    }
    recordPrice(db, { instrumentId: inst.id, price: price(100), asOf: "2025-01-10", source: "t" });

    const holdingA = listHoldings(db, a)[0]!;
    recordSale(db, actor, { holdingId: holdingA.id, units: units(10), price: price(100), date: "2025-03-01" });
    recordSplit(db, actor, { holdingId: listHoldings(db, b)[0]!.id, date: "2025-05-01", ratio: 2, kind });

    assert.equal(holdingValueOn(db, holdingA.id, "2025-02-01")!.value, rupees(1_000),
      "ten units at ₹100 were held on 1 February");
    const statement = netWorthStatement(db, "2025-02-01");
    const investments = statement.assetGroups.find((g) => g.name === "Investments")!;
    assert.equal(investments.total, rupees(2_000));
  });
}
