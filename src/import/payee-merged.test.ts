/**
 * IMPORTS-SCHEDULES-29 · An import files to the payee a merge kept.
 *
 * findExistingPayee looked a merchant up by name and took the row it found,
 * merged away or not, so after merging "ZZ Food" into "ZZ Food Online" every
 * new import posted to the loser — a payee /payees no longer lists, outside
 * the winner's history and reports. A row staged before the merge carried the
 * loser's id into approval the same way.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { queryOne } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { createAccount } from "../domain/accounts.ts";
import { createGroup, createCategory } from "../domain/budget.ts";
import { resolvePayee } from "../domain/transactions.ts";
import { listStaged } from "./pipeline.ts";
import { freshDb, seedMember, startTestApp } from "../web/harness.test-data.ts";

const actor: Actor = { memberId: "m-ravi", source: "ui" };

describe("IMPORTS-SCHEDULES-29 · imports follow a payee merge", () => {
  test("imported before and after the merge, both post to the winner", async () => {
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    const account = createAccount(db, actor, {
      name: "ZZ Savings", kind: "budget", subtype: "savings", openingDate: "2026-01-01",
    });
    const g = createGroup(db, actor, "ZZ Group");
    const eating = createCategory(db, actor, { groupId: g.id, name: "ZZ Eating out" }).id;
    const loser = resolvePayee(db, actor, "Zzfood");
    const winner = resolvePayee(db, actor, "Zzfood Online");
    const app = await startTestApp(db, { memberId: "m-ravi" });
    try {
      // Staged while the loser still stood on its own.
      await app.post("/import", {
        account_id: account.id, file_name: "a.csv",
        csv: "Date,Narration,Amount\n02-09-2026,UPI/ZZFOOD/ORDER,-300.00",
      });
      const early = listStaged(db)[0]!;
      assert.equal(early.payee_id, loser.id);

      assert.equal((await app.post("/payees/merge", { loser_id: loser.id, winner_id: winner.id })).status, 303);

      await app.post("/import", {
        account_id: account.id, file_name: "b.csv",
        csv: "Date,Narration,Amount\n03-09-2026,UPI/ZZFOOD/ORDER,-450.00",
      });
      const late = listStaged(db).find((r) => r.id !== early.id)!;
      assert.equal(late.payee_id, winner.id);

      for (const row of [early, late]) {
        assert.equal((await app.post("/review/approve", { staged_id: row.id, category_id: eating })).status, 303);
        const tx = queryOne<{ payee_id: string }>(db,
          `SELECT t.payee_id FROM transactions t JOIN staged_transactions s ON s.transaction_id = t.id
            WHERE s.id = ?`, row.id)!;
        assert.equal(tx.payee_id, winner.id);
      }
    } finally {
      await app.close();
    }
  });
});
