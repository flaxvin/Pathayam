/**
 * ENG-8 · The advance-tax table says when a "short" is not owed.
 *
 * The schedule spreads the year's whole tax over the four instalments, so a
 * capital gain that arose in February showed the June and September
 * instalments as short. The proviso to section 234C exempts the tax on a gain
 * from the instalments due before it arose, if it is paid in the remaining
 * instalments. The figures are unchanged (interest is not computed); the
 * screen now says so beside the table.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";

test("the advance-tax section names the 234C proviso for gains", async () => {
  const db = freshDb();
  seedMember(db, "m", "Ravi");
  const app = await startTestApp(db, { memberId: "m" });
  try {
    await app.post("/tax", { fy: "2025", gross: "2075000", s80c: "0", s80d: "0", other: "0" });
    const page = await (await app.get("/tax?fy=2025")).text();
    const advance = page.slice(page.indexOf('id="advance"'));
    assert.ok(page.includes('id="advance"'), "the advance-tax section is shown");
    assert.match(advance, /capital gain[\s\S]{0,200}after an instalment's due date[\s\S]{0,300}234C/);
  } finally { await app.close(); }
});
