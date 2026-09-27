/**
 * IMPORTS-SCHEDULES-33 · /import lists only the saved mappings the viewer's
 * accounts own.
 *
 * A mapping is named after its account ("<account> columns"), and /import
 * listed every one: Priya's import into her private account put its name on
 * Ravi's import page, with a Remove button that then answered 404.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createAccount } from "../domain/accounts.ts";
import { ensurePersonalBudget } from "../domain/budgets.ts";
import { freshDb, seedMember, startTestApp } from "../web/harness.test-data.ts";

test("IMPORTS-SCHEDULES-33 · another member's private mapping is not listed", async () => {
  const db = freshDb();
  seedMember(db, "m-ravi", "Ravi");
  seedMember(db, "m-priya", "Priya");
  const hers = createAccount(db, { memberId: "m-priya", source: "ui" }, {
    name: "QQ Priya hidden savings", kind: "budget", subtype: "savings", openingDate: "2026-08-01",
    visibility: "private", holderMemberId: "m-priya",
    budgetId: ensurePersonalBudget(db, "m-priya", "Priya").id,
  }).id;
  const priya = await startTestApp(db, { memberId: "m-priya" });
  try {
    await priya.post("/import", {
      account_id: hers, file_name: "zz.csv", csv: "Date,Narration,Amount\n02-09-2026,ZZ SHOP,-10.00",
    });
    assert.match(await (await priya.get("/import")).text(), /QQ Priya hidden savings/);
  } finally {
    await priya.close();
  }
  const ravi = await startTestApp(db, { memberId: "m-ravi" });
  try {
    assert.doesNotMatch(await (await ravi.get("/import")).text(), /QQ Priya hidden savings/);
  } finally {
    await ravi.close();
  }
});
