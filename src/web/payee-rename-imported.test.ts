/**
 * An explicit rename on the edit form sets the typed payee, on an imported row
 * too. The edit route resolved the typed name with the row's narration as the
 * raw string, and an imported row's narration is already an alias of its
 * current payee — so the alias won, the old payee came back, and the form said
 * "Saved." with nothing changed.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";
import { queryAll, queryOne } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { createAccount } from "../domain/accounts.ts";
import { createGroup, createCategory } from "../domain/budget.ts";
import { getPayee, getTransaction } from "../domain/transactions.ts";
import { ensurePersonalBudget } from "../domain/budgets.ts";
import { listStaged } from "../import/pipeline.ts";

const RAVI = "m-ravi";
const PRIYA = "m-priya";
const ravi: Actor = { memberId: RAVI, source: "ui" };

async function importOne(app: Awaited<ReturnType<typeof startTestApp>>, db: ReturnType<typeof freshDb>,
  accountId: string, narration: string, categoryId: string): Promise<string> {
  await app.post("/import", {
    account_id: accountId, file_name: `${narration.slice(0, 8)}.csv`,
    csv: `Date,Narration,Amount\n03-09-2026,${narration},-300.00`,
  });
  const row = listStaged(db).find((r) => r.raw_narration === narration)!;
  assert.equal((await app.post("/review/approve", { staged_id: row.id, category_id: categoryId })).status, 303);
  return queryOne<{ transaction_id: string }>(db,
    `SELECT transaction_id FROM staged_transactions WHERE id = ?`, row.id)!.transaction_id;
}

describe("renaming the payee of an imported row", () => {
  test("takes the typed name, keeps learning on a shared row and privacy on a private one", async () => {
    const db = freshDb();
    seedMember(db, RAVI, "Ravi");
    seedMember(db, PRIYA, "Priya");
    const his = ensurePersonalBudget(db, RAVI, "Ravi");
    const joint = createAccount(db, ravi, {
      name: "Joint", kind: "budget", subtype: "savings", openingDate: "2026-01-01", openingBalance: 1_000_000,
    });
    const priv = createAccount(db, ravi, {
      name: "Ravi private", kind: "budget", subtype: "savings", openingDate: "2026-01-01",
      openingBalance: 1_000_000, holderMemberId: RAVI, visibility: "private", budgetId: his.id,
    });
    const g = createGroup(db, ravi, "ZZ Group");
    const cat = createCategory(db, ravi, { groupId: g.id, name: "ZZ Food" }).id;
    const asRavi = await startTestApp(db, { memberId: RAVI });
    try {
      const shared = await importOne(asRavi, db, joint.id, "UPI/ZZFOODCO/ORDER123", cat);
      const before = getTransaction(db, shared)!.payee_id;
      assert.ok(before, "the import gave the row a payee");
      assert.ok(queryOne(db, `SELECT 1 AS x FROM payee_aliases WHERE raw = ?`, "UPI/ZZFOODCO/ORDER123"));

      assert.equal((await asRavi.post(`/transaction/${shared}`, { payee: "Zz Food Company" })).status, 303);
      assert.equal(getPayee(db, getTransaction(db, shared)!.payee_id!)!.name, "Zz Food Company");
      // A rename on a row everyone can see still teaches a rule (L1).
      const rules = queryAll<{ name: string }>(db, `SELECT name FROM rules WHERE proposed = 1`);
      assert.ok(rules.some((r) => r.name.endsWith("→ Zz Food Company")), JSON.stringify(rules));

      const secret = await importOne(asRavi, db, priv.id, "UPI/DRSHARMAPSYCH/9", cat);
      assert.equal((await asRavi.post(`/transaction/${secret}`, { payee: "Zz Doctor Visit" })).status, 303);
      assert.equal(getPayee(db, getTransaction(db, secret)!.payee_id!)!.name, "Zz Doctor Visit");
      assert.deepEqual(asRavi.failures, []);
    } finally { await asRavi.close(); }

    // WEB-1 / P-1: no rule from the private row, and neither name reaches Priya.
    assert.ok(!queryAll<{ name: string }>(db, `SELECT name FROM rules`).some((r) => /Doctor|DRSHARMA/i.test(r.name)));
    const asPriya = await startTestApp(db, { memberId: PRIYA });
    try {
      for (const path of ["/payees", "/add", "/activity", "/rules", "/review", "/export.json"]) {
        const text = await (await asPriya.get(path)).text();
        assert.doesNotMatch(text, /DRSHARMAPSYCH|Zz Doctor Visit/i, path);
      }
      assert.deepEqual(asPriya.failures, []);
    } finally { await asPriya.close(); }
  });
});
