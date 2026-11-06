/**
 * IMP-8 · An unsigned amount column beside a balance column.
 *
 * A card CSV of "Amount, Balance" — "1,299.00" and "1,749.00 Dr" — has
 * nothing on the amount saying which way it went, and every row imported
 * as money in. The balance says: its movement between two rows is the
 * amount, sign included, which is how the PDF reader has always read a
 * statement (rule 1). Applied only when every amount in the file is bare,
 * and only when the movements agree with the printed amounts.
 *
 * Fictional rows throughout.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { applyMapping, parseDelimited, parseStatement } from "./csv.ts";

const mapping = { headerRow: 0, date: 0, narration: 1, amount: 2, balance: 3 };

describe("IMP-8 · sign from the balance's movement", () => {
  test("a card file with an opening balance: purchases out, the payment in", () => {
    const rows = parseDelimited(
      `Date,Description,Amount,Balance
,Opening Balance,,"1,000.00 Dr"
02-09-2026,ZZ FOODS,450.00,"1,450.00 Dr"
05-09-2026,PAYMENT RECEIVED,"1,000.00",450.00 Dr
08-09-2026,ZZ BOOKS,"1,299.00","1,749.00 Dr"`,
    );
    const out = applyMapping(rows, mapping);
    assert.deepEqual(out.records.map((r) => r.amount), [-45000, 100000, -129900]);
    assert.deepEqual(out.errors, []);
  });

  test("newest first, no opening balance: the earliest row is reported, not guessed", () => {
    const rows = parseDelimited(
      `Date,Narration,Amount,Balance
10-09-2026,ATM ZZ,500.00,"9,500.00"
05-09-2026,SALARY ZZ,"5,000.00","10,000.00"
01-09-2026,KIRANA ZZ,200.00,"5,000.00"`,
    );
    const out = applyMapping(rows, mapping);
    assert.deepEqual(out.records.map((r) => [r.narration, r.amount]),
      [["ATM ZZ", -50000], ["SALARY ZZ", 500000]]);
    assert.equal(out.errors.length, 1);
    assert.equal(out.errors[0]!.rowNumber, 4);
    assert.match(out.errors[0]!.reason, /balance/);
  });

  test("the guessed mapping does the same", () => {
    const { result } = parseStatement(
      `Date,Description,Amount,Balance
,Opening Balance,,"1,000.00 Dr"
02-09-2026,ZZ FOODS,450.00,"1,450.00 Dr"
05-09-2026,PAYMENT RECEIVED,"1,000.00",450.00 Dr`,
    );
    assert.deepEqual(result.records.map((r) => r.amount), [-45000, 100000]);
  });

  test("movements that do not match the amounts leave the file as it was read", () => {
    const rows = parseDelimited(
      `Date,Narration,Amount,Balance
01-09-2026,ZZ ONE,100.00,"5,000.00"
02-09-2026,ZZ TWO,200.00,"7,000.00"`,
    );
    const out = applyMapping(rows, mapping);
    assert.deepEqual(out.records.map((r) => r.amount), [10000, 20000]);
    assert.deepEqual(out.errors, []);
  });

  test("a file that signs its amounts is read from its signs, not the balance", () => {
    const rows = parseDelimited(
      `Date,Narration,Amount,Balance
01-09-2026,ZZ ONE,-100.00,"4,900.00"
02-09-2026,ZZ TWO,200.00,"5,100.00"`,
    );
    const out = applyMapping(rows, mapping);
    assert.deepEqual(out.records.map((r) => r.amount), [-10000, 20000]);
    assert.deepEqual(out.errors, []);
  });
});
