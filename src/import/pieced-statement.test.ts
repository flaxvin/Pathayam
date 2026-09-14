/**
 * A statement the page drew in pieces.
 *
 * Some generators emit every figure as several text runs. The layout pass
 * places each run at the column its position implies, so one number comes out
 * with spaces through it: "27,333.00" reads "2 7,3 33.0 0" and "27-03-2026"
 * reads "2 7-03 -202 6". The header goes the same way — "DAT E", "DE POSITS",
 * "WITH  D RAWA  LS" — and once the header is unreadable no column is known.
 *
 * The failure is silent and total. Three of this household's own ICICI savings
 * statements parsed to **zero rows** with **zero errors**: the file opened, the
 * text was all there, and nothing in it looked like a transaction.
 *
 * Fixing the dates and figures alone is worse than not fixing them. Without the
 * header the parser cannot tell a balance from an amount, and it reads the
 * running balance as the movement — every row plausible, every number wrong.
 * So this holds all three together, and holds the amounts, not just the count.
 *
 * The layout below is the real shape. The figures are invented.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseStatementText, readHeader, findDate } from "./pdf-statements.ts";

/** As a well-behaved generator lays it out. */
const CLEAN = [
  " DATE        MODE      PARTICULARS                    DEPOSITS   WITHDRAWALS      BALANCE",
  " 01-03-2026            B/F                                                        3,807.04",
  " 27-03-2026  UPI       UPI/608673779307/GROCER                       3,000.00       807.04",
  " 30-03-2026            Int.Pd:31-12-2025 to 29-03        23.00                      830.04",
].join("\n");

/** The same table, every figure and heading drawn in pieces. */
const PIECED = [
  " DAT E       MOD E     PARTICULA  RS                   DE POSITS  WITH  D RAWA  LS   BAL ANCE",
  " 0 1-03 -202 6         B/F                                                        3,807 .04",
  " 2 7-03 -202 6  UPI    UPI/608673779307/GROCER                       3,0 00.0 0     807 .04",
  " 3 0-03 -202 6         Int.Pd:31-12-2025 to 29-03        23 .00                     830 .04",
].join("\n");

describe("a statement drawn in pieces still reads", () => {
  test("a date split across runs is found, in its original place", () => {
    const strict = findDate(" 30-03-2026  Int.Pd");
    const pieced = findDate(" 3 0-03 -202 6  Int.Pd");
    assert.equal(strict?.date, "2026-03-30");
    assert.equal(pieced?.date, "2026-03-30", "the pieced date was not read");
    // The span covers the spaces, so every column after it keeps its offset —
    // repairing the text instead shifts them, and the parse then reads the
    // balance column as the amount.
    assert.equal(pieced?.start, 1);
    assert.equal(pieced?.end, 14);
  });

  test("prose with a date in it is still not a transaction", () => {
    assert.equal(findDate("EMI due 05-09-2026 next month"), null);
  });

  test("a header split across runs is still a header", () => {
    const header = readHeader([PIECED.split("\n")[0]!]);
    assert.ok(header, "the pieced header was not recognised, so no column is known");
    assert.ok(header!.debit && header!.credit && header!.balance);
    // The spans have to sit where the words actually are, or figures match the
    // wrong column.
    assert.ok(header!.credit!.start < header!.debit!.start, "deposits comes before withdrawals");
    assert.ok(header!.debit!.start < header!.balance!.start, "withdrawals comes before balance");
  });

  test("the same table, drawn either way, gives the same transactions", () => {
    const clean = parseStatementText(CLEAN);
    const pieced = parseStatementText(PIECED);

    assert.deepEqual(
      clean.records.map((r) => [r.date, r.amount]),
      [["2026-03-27", -300000], ["2026-03-30", 2300]],
      "the clean table should read one withdrawal and one deposit",
    );
    assert.deepEqual(
      pieced.records.map((r) => [r.date, r.amount]),
      clean.records.map((r) => [r.date, r.amount]),
      "the pieced table read different money from the same table",
    );
  });

  test("the balance carried in is not a transaction", () => {
    for (const text of [CLEAN, PIECED]) {
      const amounts = parseStatementText(text).records.map((r) => r.amount);
      assert.ok(
        !amounts.includes(-380704),
        "the brought-forward balance was imported as a payment of ₹3,807.04",
      );
    }
  });
});
