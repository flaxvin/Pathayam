/**
 * REV-1 · A CAS confirmation that is refused can be retried on the same review.
 *
 * The confirmation took the plan out of the stash before applying it, so a
 * refusal — a redemption of units the ledger never bought — spent the plan,
 * and unticking the scheme the refusal named led to "no longer open". Every
 * figure is synthetic.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Actor } from "../core/events.ts";
import { queryAll } from "../db/db.ts";
import { createAssetAccount } from "../domain/assets.ts";
import { safeGoldPdf } from "../import/safegold.test-data.ts";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";

const actor: Actor = { memberId: "m", source: "ui" };

const CAS = `
Folio No: 5555
Steady Fund - Growth
ISIN: INF000A01011
05/05/2026  Purchase  1,000.00  10.000  100.0000  10.000
Closing Unit Balance: 10.000
Folio No: 6666
Other Fund - Growth
ISIN: INF000B02022
20/06/2026  Redemption  5,000.00  50.000  100.0000  0.000
`;

describe("REV-1 · confirming a CAS after a refusal", () => {
  test("unticking the refused scheme and confirming again records the rest", async () => {
    const db = freshDb();
    seedMember(db, "m", "Ravi");
    const account = createAssetAccount(db, actor, { name: "Mutual funds", subtype: "investment", openingDate: "2026-04-01" });
    const app = await startTestApp(db, { memberId: "m" });
    try {
      const form = new FormData();
      form.set("account_id", account.id);
      form.set("statement", new Blob([safeGoldPdf(CAS)], { type: "application/pdf" }), "cas.pdf");
      const page = await (await app.get("/portfolio/cas", {
        method: "POST", body: form, headers: { Origin: app.baseUrl },
      })).text();
      const token = /name="token" value="([^"]+)"/.exec(page)?.[1];
      assert.ok(token, "a confirmation form");

      const refused = await app.post("/portfolio/cas/confirm", {}, {
        body: new URLSearchParams([["token", token], ["scheme", "0"], ["scheme", "1"]]).toString(),
      });
      assert.equal(refused.status, 422);
      assert.equal(queryAll(db, `SELECT id FROM lots`).length, 0);

      const ok = await app.post("/portfolio/cas/confirm", { token, scheme: "0" });
      assert.equal(ok.status, 303);
      assert.doesNotMatch(ok.headers.get("location") ?? "", /error=expired/);
      assert.equal(queryAll(db, `SELECT id FROM lots`).length, 1);

      const spent = await app.post("/portfolio/cas/confirm", { token, scheme: "0" });
      assert.match(spent.headers.get("location") ?? "", /error=expired/);
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });
});
