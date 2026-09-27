/**
 * WEBUX-12 · A split or merger ratio no real corporate action has is refused.
 *
 * The routes checked only for a finite number above zero. 1e308 is both, and
 * units × ratio overflowed to Infinity — stored by SQLite as NULL — so the
 * holding read "Market value ₹NaN.NaN" and, a split being irreversible, was
 * lost. Ratios are now bounded to a thousand to one either way.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { queryAll } from "../db/db.ts";
import { units, price } from "../portfolio/holdings.ts";
import {
  createAssetAccount, findOrCreateInstrument, recordPurchase, listHoldings,
} from "../domain/assets.ts";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";

describe("WEBUX-12 · corporate-action ratios are bounded", () => {
  test("a huge split or merger ratio is a 422 and leaves the lots alone", async () => {
    const db = freshDb();
    seedMember(db, "m", "Ravi");
    const actor = { memberId: "m", source: "ui" as const };
    const demat = createAssetAccount(db, actor, { name: "Demat", subtype: "investment" }).id;
    const inst = findOrCreateInstrument(db, actor, { name: "Fictional Fund", kind: "mutual-fund" }).id;
    recordPurchase(db, actor, {
      accountId: demat, instrumentId: inst, tradeDate: "2025-06-01", price: price(100), units: units(10),
    });
    const holdingId = listHoldings(db, demat)[0]!.id;
    const app = await startTestApp(db, { memberId: "m" });
    try {
      for (const ratio of ["1e308", "1e300", "5000", "0.00001"]) {
        const split = await app.post(`/portfolio/${holdingId}/split`, { ratio, kind: "split", date: "2025-09-20" });
        assert.equal(split.status, 422, `split ratio ${ratio}`);
        const merge = await app.post(`/portfolio/${holdingId}/merge`, { ratio, date: "2025-09-20" });
        assert.equal(merge.status, 422, `merger ratio ${ratio}`);
      }
      assert.deepEqual(
        queryAll<{ units: number }>(db, `SELECT units FROM lots WHERE holding_id = ?`, holdingId)
          .map((l) => l.units),
        [units(10)],
      );
      // An ordinary split still goes through.
      const ok = await app.post(`/portfolio/${holdingId}/split`, { ratio: "5", kind: "split", date: "2025-09-20" });
      assert.equal(ok.status, 303);
    } finally {
      await app.close();
    }
  });
});
