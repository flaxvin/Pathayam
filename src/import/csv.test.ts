import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseDelimited, detectDelimiter, guessMapping, applyMapping, parseStatement,
  headerSignature,
} from "./csv.ts";
import { rupees } from "../core/money.ts";

describe("parseDelimited", () => {
  test("handles quotes, embedded delimiters and doubled quotes", () => {
    assert.deepEqual(parseDelimited('a,"b,c",d\n1,2,3'), [["a", "b,c", "d"], ["1", "2", "3"]]);
    assert.deepEqual(parseDelimited('"say ""hi""",x'), [['say "hi"', "x"]]);
  });

  test("keeps a multi-line narration inside its cell (04 §3.2)", () => {
    const rows = parseDelimited('date,narration\n01-08-2026,"UPI/P2M/4213/\nSWIGGY*ORDER"');
    assert.equal(rows.length, 2);
    assert.equal(rows[1]![1], "UPI/P2M/4213/\nSWIGGY*ORDER");
  });

  test("handles CRLF and a trailing newline", () => {
    assert.deepEqual(parseDelimited("a,b\r\n1,2\r\n"), [["a", "b"], ["1", "2"]]);
  });

  test("strips a BOM, which survives every Excel export", () => {
    assert.equal(parseDelimited("﻿Date,Narration\n")[0]![0], "Date");
  });

  test("detects the delimiter", () => {
    assert.equal(detectDelimiter("a,b,c\n1,2,3"), ",");
    assert.equal(detectDelimiter("a\tb\tc\n1\t2\t3"), "\t");
    assert.equal(detectDelimiter("a;b;c\n1;2;3"), ";");
  });
});

describe("guessMapping", () => {
  test("finds an HDFC-shaped header with separate debit and credit columns", () => {
    const rows = parseDelimited(
      `Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance
01-08-26,SALARY CREDIT,,01-08-26,,145000.00,145000.00`,
    );
    const mapping = guessMapping(rows)!;
    assert.equal(mapping.headerRow, 0);
    assert.equal(mapping.date, 0);
    assert.equal(mapping.narration, 1);
    assert.equal(mapping.debit, 4);
    assert.equal(mapping.credit, 5);
    assert.equal(mapping.balance, 6);
  });

  test("finds a header that is not row 1 (04 §3.2)", () => {
    const rows = parseDelimited(
      `Statement of Account
Account No: XXXXXXXX6612
Period: 01-08-2026 to 31-08-2026

Transaction Date,Transaction Remarks,Withdrawal Amount,Deposit Amount,Balance
02-08-2026,UPI/DMART,1450.00,,143550.00`,
    );
    const mapping = guessMapping(rows)!;
    assert.equal(mapping.headerRow, 4);
    assert.equal(mapping.narration, 1);
  });

  test("handles a single signed amount column", () => {
    const rows = parseDelimited(`Date,Description,Amount\n01-08-2026,SWIGGY,-450.00`);
    const mapping = guessMapping(rows)!;
    assert.equal(mapping.amount, 2);
    assert.equal(mapping.debit, undefined);
  });

  test("returns null when nothing looks like a statement", () => {
    // An unrecognised file is a mapping task, not an error — the caller shows
    // the raw rows and asks.
    assert.equal(guessMapping(parseDelimited("foo,bar\n1,2")), null);
  });
});

describe("applyMapping", () => {
  test("signs debits negative and credits positive", () => {
    const { result } = parseStatement(
      `Date,Narration,Withdrawal Amt.,Deposit Amt.
01-08-2026,SALARY,,"1,45,000.00"
02-08-2026,DMART,"1,450.50",`,
    );
    assert.equal(result.records.length, 2);
    assert.equal(result.records[0]!.amount, rupees(145_000));
    assert.equal(result.records[1]!.amount, rupees(-1_450.5));
  });

  test("reads Indian grouping and Cr/Dr suffixes", () => {
    const { result } = parseStatement(
      `Date,Particulars,Amount
01-08-2026,SALARY,"1,45,000.00 Cr"
02-08-2026,RENT,"41,000.00 Dr"`,
    );
    assert.equal(result.records[0]!.amount, rupees(145_000));
    assert.equal(result.records[1]!.amount, rupees(-41_000));
  });

  test("retains the raw values unchanged (P4, I1)", () => {
    const { result } = parseStatement(
      `Date,Narration,Withdrawal Amt.,Deposit Amt.
02-08-2026,UPI/P2M/4213/SWIGGY*ORDER,"1,450.50",`,
    );
    const record = result.records[0]!;
    assert.equal(record.raw.date, "02-08-2026");
    assert.equal(record.raw.amount, "1,450.50");
    assert.equal(record.raw.narration, "UPI/P2M/4213/SWIGGY*ORDER");
  });

  test("skips footer rows without reporting them as errors", () => {
    const { result } = parseStatement(
      `Date,Narration,Withdrawal Amt.,Deposit Amt.
01-08-2026,SALARY,,145000.00

Total,,0.00,145000.00
This is a computer generated statement and does not require a signature.`,
    );
    assert.equal(result.records.length, 1);
    assert.equal(result.errors.length, 0, "footers are noise, not defects");
  });

  test("reports a genuinely broken row with the offending cells (IL3)", () => {
    const { result } = parseStatement(
      `Date,Narration,Withdrawal Amt.,Deposit Amt.
01-08-2026,SALARY,,145000.00
02-08-2026,MYSTERY,not-an-amount,`,
    );
    assert.equal(result.records.length, 1);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0]!.rowNumber, 3);
    assert.match(result.errors[0]!.reason, /not an amount I can read/);
    assert.ok(result.errors[0]!.cells.includes("MYSTERY"), "the raw row is shown, never swallowed");
  });

  test("captures a reference number, which the strong dedupe tier needs", () => {
    const { result } = parseStatement(
      `Date,Narration,Chq./Ref.No.,Withdrawal Amt.,Deposit Amt.
02-08-2026,UPI/DMART,431202847592,1450.00,`,
    );
    assert.equal(result.records[0]!.reference, "431202847592");
  });

  test("handles a two-digit year", () => {
    const { result } = parseStatement(
      `Date,Narration,Withdrawal Amt.,Deposit Amt.\n01-08-26,SALARY,,145000.00`,
    );
    assert.equal(result.records[0]!.date, "2026-08-01");
  });
});

describe("headerSignature", () => {
  test("is stable across whitespace, case and punctuation", () => {
    assert.equal(
      headerSignature(["Date", "Narration", "Withdrawal Amt."]),
      headerSignature([" date ", "NARRATION", "withdrawal amt"]),
    );
  });

  test("differs between banks, so the right profile is picked", () => {
    assert.notEqual(
      headerSignature(["Date", "Narration", "Withdrawal Amt."]),
      headerSignature(["Transaction Date", "Transaction Remarks", "Withdrawal Amount"]),
    );
  });
});
