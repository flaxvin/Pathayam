/**
 * I5 · The same line, on two different accounts, is two payments.
 *
 * A statement row's identity is a hash of its date, amount, narration and
 * reference — which is what makes re-importing a file idempotent, and which two
 * different accounts can produce identically. "UPI/SWIGGY/4471" for ₹450 on the
 * 5th of August is one payment from the joint account and a different one from a
 * personal account, and a household with two accounts at the same bank meets
 * this the first time it imports both statements.
 *
 * The pipeline always knew: its duplicate check is scoped to the account being
 * imported into, so it staged both rows. The database's unique index was not,
 * so approving the second one failed with "UNIQUE constraint failed" — a 500
 * with SQL in it, and a row stuck in the queue that could never be approved.
 *
 * Two layers disagreeing about what makes a row unique. This holds them to the
 * same answer: both halves matter, so both are tested here.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember } from "../web/harness.test-data.ts";
import { createAccount } from "../domain/accounts.ts";
import { createGroup, createCategory } from "../domain/budget.ts";
import { parseDelimited, applyMapping } from "./csv.ts";
import { ingest, listStaged, approveStaged } from "./pipeline.ts";
import { queryAll } from "../db/db.ts";
import { rupees, type Paise } from "../core/money.ts";
import type { Actor } from "../core/events.ts";

const RAVI = "m-ravi";
const ravi: Actor = { memberId: RAVI, source: "ui" };

/** One line. Two households' worth of ways to meet it twice. */
const CSV = "Date,Narration,Withdrawal,Deposit\n05/08/2026,UPI/SWIGGY/4471,450.00,\n";

function setup() {
  const db = freshDb();
  seedMember(db, RAVI, "Ravi");
  const account = (name: string) => createAccount(db, ravi, {
    name, kind: "budget", subtype: "savings",
    openingDate: "2026-01-01", openingBalance: rupees(1_00_000) as Paise,
  }).id;
  const group = createGroup(db, ravi, "Everyday");
  return {
    db,
    joint: account("Joint current"),
    mine: account("My salary account"),
    category: createCategory(db, ravi, { groupId: group.id, name: "Going out" }).id,
  };
}

function importInto(db: ReturnType<typeof setup>["db"], accountId: string, label: string) {
  const parsed = applyMapping(parseDelimited(CSV), {
    headerRow: 0, date: 0, narration: 1, debit: 2, credit: 3,
  });
  return ingest(db, ravi, {
    accountId, source: "csv", adapter: "hdfc", fileName: `${label}.csv`,
    records: parsed.records, errors: parsed.errors, rowsRead: 1,
  });
}

describe("I5 · one statement line, two accounts", () => {
  test("both are staged, and both can be approved", () => {
    const { db, joint, mine, category } = setup();

    for (const [label, account] of [["joint", joint], ["mine", mine]] as const) {
      const result = importInto(db, account, label);
      assert.equal(result.staged, 1, `${label}: the row was not queued`);
      assert.equal(result.skipped, 0, `${label}: it was mistaken for a re-import`);

      for (const row of listStaged(db, { batchId: result.batch.id })) {
        approveStaged(db, ravi, row.id, { categoryId: category });
      }
    }

    const landed = queryAll<{ account_id: string }>(
      db, `SELECT account_id FROM transactions WHERE deleted_at IS NULL AND source = 'csv'`,
    );
    assert.equal(landed.length, 2, "one of the two payments did not reach the ledger");
    assert.deepEqual(
      new Set(landed.map((t) => t.account_id)), new Set([joint, mine]),
      "both rows landed on the same account",
    );
  });

  test("and re-importing the same file into the same account still adds nothing (I5)", () => {
    const { db, joint, category } = setup();

    const first = importInto(db, joint, "august");
    for (const row of listStaged(db, { batchId: first.batch.id })) {
      approveStaged(db, ravi, row.id, { categoryId: category });
    }

    const again = importInto(db, joint, "august");
    assert.equal(again.staged, 0, "the same file queued its rows a second time");
    assert.equal(
      queryAll(db, `SELECT id FROM transactions WHERE deleted_at IS NULL AND source = 'csv'`).length,
      1,
      "re-importing doubled the ledger, which is what the source id exists to stop",
    );
  });
});
