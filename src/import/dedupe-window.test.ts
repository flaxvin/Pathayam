/**
 * IMPORTS-SCHEDULES-7 · Dedupe sees the ledger around the file, not its latest 2,000 rows.
 *
 * loadCandidates took the account's 2,000 most recent transactions. Once a
 * busy account passed that, re-importing an approved Feb-2022 statement staged
 * both its rows again (I5 broken) — and an alert typed by hand back then was
 * as invisible to the fuzzy tiers.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execute, newId, queryOne } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST, addDays, type IsoDate } from "../core/dates.ts";
import { createAccount } from "../domain/accounts.ts";
import { createGroup, createCategory } from "../domain/budget.ts";
import { parseStatement } from "./csv.ts";
import { ingest, listStaged, approveStaged } from "./pipeline.ts";
import { freshHousehold, RAVI } from "../engine/identity.test-data.ts";

const actor: Actor = { memberId: RAVI, source: "ui" };

function busyAccount() {
  const db = freshHousehold();
  const account = createAccount(db, actor, {
    name: "ZZ Savings", kind: "budget", subtype: "savings", openingDate: "2022-01-01",
  }).id;
  const cat = createCategory(db, actor, { groupId: createGroup(db, actor, "ZZ G").id, name: "ZZ E" }).id;
  const imp = (csv: string) => {
    const { result } = parseStatement(csv);
    return ingest(db, actor, {
      accountId: account, source: "csv", adapter: "csv", fileName: "old.csv",
      records: result.records, errors: result.errors, rowsRead: result.rowsRead,
    });
  };
  const later = () => {
    const now = nowIST();
    for (let i = 0; i < 2100; i++) {
      execute(db,
        `INSERT INTO transactions (id,account_id,date,amount,category_id,source,created_at,updated_at,is_split,cleared,reimbursable)
         VALUES (?,?,?,?,?,'manual',?,?,0,1,0)`,
        newId(), account, addDays("2023-01-01" as IsoDate, i % 900), -100, cat, now, now);
    }
  };
  return { db, account, cat, imp, later };
}

const OLD = "Date,Narration,Amount\n05-02-2022,UPI/ZZ SHOP A,-120.00\n06-02-2022,UPI/ZZ SHOP B,-130.00";

describe("IMPORTS-SCHEDULES-7 · dedupe past the latest 2,000 rows", () => {
  test("re-importing an approved old statement skips every row", () => {
    const { db, cat, imp, later } = busyAccount();
    imp(OLD);
    for (const r of listStaged(db)) approveStaged(db, actor, r.id, { categoryId: cat });
    later();
    const again = imp(OLD);
    assert.deepEqual({ staged: again.staged, skipped: again.skipped }, { staged: 0, skipped: 2 });
    assert.equal(listStaged(db).length, 0);
  });

  test("an old hand-typed entry is still offered as the imported row's twin", () => {
    const { db, account, cat, imp, later } = busyAccount();
    const now = nowIST();
    execute(db,
      `INSERT INTO transactions (id,account_id,date,amount,category_id,source,created_at,updated_at,is_split,cleared,reimbursable)
       VALUES ('typed',?,'2022-02-03',-12000,?,'manual',?,?,0,0,0)`, account, cat, now, now);
    later();
    imp(OLD);
    const row = queryOne<{ duplicate_of_id: string | null }>(db,
      `SELECT duplicate_of_id FROM staged_transactions WHERE amount = -12000`);
    assert.equal(row?.duplicate_of_id, "typed");
  });
});
