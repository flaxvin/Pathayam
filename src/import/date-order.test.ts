/**
 * IMPORTS-SCHEDULES-30 · A month-first file is read month first, or asked about.
 *
 * Every CSV date was read day first. A September export written 09/03,
 * 09/13, 09/21, 09/05 staged 9 March and 9 May as valid rows — in budgets
 * months away — while 09/13 and 09/21 were "not a date I can read", and the
 * mapping screen had no way to say which order the file used.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Actor } from "../core/events.ts";
import { createAccount } from "../domain/accounts.ts";
import { parseStatement, dateOrderOf, parseDelimited } from "./csv.ts";
import { listStaged } from "./pipeline.ts";
import { freshDb, seedMember, startTestApp } from "../web/harness.test-data.ts";

const actor: Actor = { memberId: "m-ravi", source: "ui" };
const MONTH_FIRST = "Date,Description,Amount\n09/03/2026,ZZ SHOP A,-100.00\n09/13/2026,ZZ SHOP B,-200.00\n" +
  "09/21/2026 10:32,ZZ SHOP C,-300.00\n09/05/2026,ZZ SHOP D,-400.00";

describe("IMPORTS-SCHEDULES-30 · day or month first", () => {
  test("a column whose second part passes 12 is read month first", () => {
    const { result, mapping } = parseStatement(MONTH_FIRST);
    assert.equal(mapping?.dateFormat, "mm-dd-yyyy");
    assert.deepEqual(result.records.map((r) => r.date), ["2026-09-03", "2026-09-13", "2026-09-21", "2026-09-05"]);
    assert.deepEqual(result.errors, []);
  });

  test("day first stays the default, and a column proving both ways is mixed", () => {
    const { mapping, result } = parseStatement("Date,Description,Amount\n13/09/2026,ZZ A,-1\n03/09/2026,ZZ B,-2");
    assert.equal(mapping?.dateFormat, undefined);
    assert.deepEqual(result.records.map((r) => r.date), ["2026-09-13", "2026-09-03"]);
    assert.equal(dateOrderOf(parseDelimited("D,N,A\n13/09/2026,x,1\n09/13/2026,y,2"), 0, 0), "mixed");
    assert.equal(dateOrderOf(parseDelimited("D,N,A\n03/09/2026,x,1"), 0, 0), null);
  });

  test("the mapping screen asks, and /import/map honours the answer or refuses a mixed column", async () => {
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    const account = createAccount(db, actor, {
      name: "ZZ Savings", kind: "budget", subtype: "savings", openingDate: "2026-01-01",
    });
    const app = await startTestApp(db, { memberId: "m-ravi" });
    const map = (csv: string, extra: Record<string, string> = {}) => app.post("/import/map", {
      account_id: account.id, csv, delimiter: "comma", file_name: "zz.csv", profile_name: "ZZ Export",
      header_row: "0", date: "0", narration: "1", amount: "2", ...extra,
    });
    try {
      // Every day 12 or under: only the person can say, and says month first.
      const res = await map("Date,Description,Amount\n09/03/2026,ZZ A,-100.00\n09/05/2026,ZZ B,-200.00",
        { date_format: "mm-dd-yyyy" });
      assert.equal(res.status, 303);
      assert.deepEqual(listStaged(db).map((s) => s.date).sort(), ["2026-09-03", "2026-09-05"]);

      const mixed = await map("Date,Description,Amount\n13/09/2026,ZZ C,-1.00\n09/14/2026,ZZ D,-2.00");
      assert.equal(mixed.status, 400);
      assert.match(await mixed.text(), /Choose how the dates are written/);
      assert.deepEqual(app.failures, []);
    } finally { await app.close(); }
  });
});
