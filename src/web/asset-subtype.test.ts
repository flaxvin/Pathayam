/**
 * WEBUX-9 · A kind of asset outside the list is refused, not a 500.
 *
 * POST /portfolio/asset/new cast the form's subtype straight through, and
 * createAssetAccount's event summary read ASSET_LABELS[subtype].toLowerCase():
 * "gold" or "abc" answered "Something went wrong on the server" and left a
 * TypeError in request_failures. The form offers a list; anything else is a 422.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";
import { queryOne } from "../db/db.ts";

const RAVI = "m-ravi";

describe("WEBUX-9 · adding an asset of an unknown kind", () => {
  test("answers 422 and adds nothing", async () => {
    const db = freshDb();
    seedMember(db, RAVI, "Ravi");
    const app = await startTestApp(db, { memberId: RAVI });
    const count = () => queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM accounts`)!.n;
    try {
      const before = count();
      for (const subtype of ["gold", "abc", "__proto__", "toString"]) {
        const res = await app.post("/portfolio/asset/new", { name: "Gold coins", subtype, value: "50000" });
        assert.equal(res.status, 422, `subtype "${subtype}" answered ${res.status}`);
        assert.match(await res.text(), /Pick a kind of asset/);
      }
      assert.equal(count(), before);
      const ok = await app.post("/portfolio/asset/new", { name: "Gold coins", subtype: "commodity", value: "50000" });
      assert.equal(ok.status, 303);
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });
});
