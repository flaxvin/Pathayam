/**
 * IMPORTS-SCHEDULES-21 · A PDF the app cannot read imports through the
 * mapping screen.
 *
 * Two things stopped it. The fallback split each text line on runs of spaces,
 * which drops an empty cell, so a withdrawal row's balance slid left into the
 * Deposit column and every row read as "both a debit and a credit". And
 * /import/map guessed the delimiter again from the tab-joined text: an address
 * and lakh figures ("1,44,550.00") gave it more commas than tabs, so the
 * columns picked on the screen named different cells. Nothing staged, and a
 * profile was saved from the mis-split header all the same.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { queryOne } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { createAccount } from "../domain/accounts.ts";
import { listStaged } from "./pipeline.ts";
import { rowsByPosition, candidateHeaderRows } from "./profiles.ts";
import { freshDb, seedMember, startTestApp } from "../web/harness.test-data.ts";

const actor: Actor = { memberId: "m-ravi", source: "ui" };

// Laid out as the PDF text extractor lays out a statement: by position.
const LINES = [
  "ZZ Fictional Bank Ltd, 12, Example Road, Sampleton",
  "Customer: A. Sample, Flat 4, Example Nagar",
  "Date      Narration              Withdrawal      Deposit        Balance",
  "01/08/26  UPI/ZZ FOOD ORDER      450.00                         1,44,550.00",
  "02/08/26  NEFT ZZ SALARY                         1,45,000.00    2,89,550.00",
];

describe("IMPORTS-SCHEDULES-21 · the PDF mapping fallback", () => {
  test("cells are cut by position, so an empty column stays empty", () => {
    const header = candidateHeaderRows(LINES.map((l) => l.split(/\s{2,}/)))[0]!.index;
    assert.equal(header, 2);
    const rows = rowsByPosition(LINES, header);
    assert.deepEqual(rows[3], ["01/08/26", "UPI/ZZ FOOD ORDER", "450.00", "", "1,44,550.00"]);
    assert.deepEqual(rows[4], ["02/08/26", "NEFT ZZ SALARY", "", "1,45,000.00", "2,89,550.00"]);
  });

  test("/import/map splits on the delimiter the screen posts back", async () => {
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    const account = createAccount(db, actor, {
      name: "ZZ Savings", kind: "budget", subtype: "savings", openingDate: "2026-01-01",
    });
    const app = await startTestApp(db, { memberId: "m-ravi" });
    try {
      const csv = rowsByPosition(LINES, 2).map((r) => r.join("\t")).join("\n");
      const res = await app.post("/import/map", {
        account_id: account.id, csv, delimiter: "tab", file_name: "zz.pdf", profile_name: "ZZ Bank",
        header_row: "2", date: "0", narration: "1", debit: "2", credit: "3", balance: "4",
      });
      assert.equal(res.status, 303);
      const staged = listStaged(db).map((s) => [s.date, s.amount]).sort();
      assert.deepEqual(staged, [["2026-08-01", -45_000], ["2026-08-02", 14_500_000]]);
    } finally {
      await app.close();
    }
  });

  test("a mapping that reads nothing is not remembered", async () => {
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    const account = createAccount(db, actor, {
      name: "ZZ Savings", kind: "budget", subtype: "savings", openingDate: "2026-01-01",
    });
    const app = await startTestApp(db, { memberId: "m-ravi" });
    try {
      const csv = rowsByPosition(LINES, 2).map((r) => r.join("\t")).join("\n");
      const res = await app.post("/import/map", {
        account_id: account.id, csv, delimiter: "tab", file_name: "zz.pdf", profile_name: "ZZ Wrong",
        // The narration picked as the date: every row is unreadable.
        header_row: "2", date: "1", narration: "0", debit: "2", credit: "3",
      });
      assert.equal(res.status, 303);
      assert.match(decodeURIComponent(res.headers.get("location") ?? ""), /not remembered/);
      assert.equal(queryOne(db, `SELECT id FROM import_profiles`), null);
    } finally {
      await app.close();
    }
  });

  test("the mapping screen carries the delimiter it split on", async () => {
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    const account = createAccount(db, actor, {
      name: "ZZ Savings", kind: "budget", subtype: "savings", openingDate: "2026-01-01",
    });
    const app = await startTestApp(db, { memberId: "m-ravi" });
    try {
      const page = await (await app.post("/import", {
        account_id: account.id, file_name: "zz.tsv",
        csv: "Col A\tCol B\tCol C\nzz\tyy\txx\nww\tvv\tuu",
      })).text();
      assert.match(page, /name="delimiter" value="tab"/);
    } finally {
      await app.close();
    }
  });
});
