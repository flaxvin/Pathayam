import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseStatementText, parseStatementPdf, parseStatementDate, parseStatementAmount,
  detectBank, senderFor, readHeader, BANKS, WrongPassword,
} from "./pdf-statements.ts";
import { STATEMENTS, STATEMENT_PASSWORD } from "./statements.test-data.ts";

/**
 * The fixtures are real PDFs run through the real reader, so these tests
 * exercise the whole chain — extract, recognise, parse — rather than a
 * hand-typed approximation of what extraction produces. That distinction
 * caught a genuine bug: hand-written fixtures with two-space separators hid
 * the fact that column *alignment* is what disambiguates an empty debit column
 * from an empty credit one.
 *
 * They are synthetic, not this household's own statements: see the header of
 * `statements.test-data.ts`.
 */

const HDFC = extract(STATEMENTS.hdfc);
const ICICI = extract(STATEMENTS.icici);
const AXIS = extract(STATEMENTS.axis);
const SBI = extract(STATEMENTS.sbi);

function extract(bytes: Uint8Array): string {
  return parseStatementPdf(bytes, "").text;
}

describe("04 §3.3 · recognising which bank produced a statement", () => {
  test("each of the four P0 banks is recognised", () => {
    assert.equal(detectBank(HDFC)!.id, "hdfc");
    assert.equal(detectBank(ICICI)!.id, "icici");
    assert.equal(detectBank(AXIS)!.id, "axis");
    assert.equal(detectBank(SBI)!.id, "sbi");
  });

  test("an unrecognised producer is null, not a guess", () => {
    // Null is not a failure: it routes to the mapping UI, the same as an
    // unrecognised CSV.
    assert.equal(detectBank("Some Other Bank Ltd\nStatement\n01/08/2026  x  1.00"), null);
  });

  test("a bank named in a narration does not decide the producer", () => {
    // "UPI-DMART-dmart@hdfcbank" appears in ICICI statements every month.
    // Only the letterhead decides.
    const icici = ICICI.replace(
      "UPI/431202847592/Payment/SWIGGY",
      "UPI/431202847592/Payment/HDFC BANK CARD",
    );
    assert.equal(detectBank(icici)!.id, "icici");
  });

  test("every bank carries the password hint its own email gives", () => {
    // Taken from the banks' statement emails. "It is usually your PAN" is the
    // difference between an import that works and one that is abandoned.
    for (const bank of BANKS) {
      assert.ok(bank.passwordHint.length > 20, `${bank.id} needs a real hint`);
    }
    assert.match(BANKS.find((b) => b.id === "axis")!.passwordHint, /first four letters/i);
  });
});

describe("04 §3.3 · parsing the four layouts", () => {
  test("HDFC — separate withdrawal and deposit columns", () => {
    const result = parseStatementText(HDFC);
    assert.equal(result.bank!.id, "hdfc");
    assert.deepEqual(
      result.records.map((r) => [r.date, r.amount, r.reference]),
      [
        ["2026-08-03", -45_000, "431202847592"],
        ["2026-08-05", 14_500_000, "N123456789"],
        ["2026-08-11", -145_050, "998877665544"],
      ],
    );
    assert.match(result.records[0]!.narration, /SWIGGY/);
  });

  test("ICICI — a value date and a transaction date, neither of them narration", () => {
    const result = parseStatementText(ICICI);
    assert.equal(result.bank!.id, "icici");
    assert.deepEqual(
      result.records.map((r) => [r.date, r.amount]),
      [["2026-08-02", -45_000], ["2026-08-06", 14_500_000]],
    );
    // The second date column is metadata; it must not end up in the payee.
    assert.ok(!result.records[0]!.narration.includes("2026"));
  });

  test("Axis — DD-MM-YYYY, debit and credit columns", () => {
    const result = parseStatementText(AXIS);
    assert.equal(result.bank!.id, "axis");
    assert.deepEqual(
      result.records.map((r) => [r.date, r.amount]),
      [["2026-08-04", -45_000], ["2026-08-07", 14_500_000], ["2026-08-14", -500_000]],
    );
  });

  test("SBI — named months", () => {
    const result = parseStatementText(SBI);
    assert.equal(result.bank!.id, "sbi");
    assert.deepEqual(
      result.records.map((r) => [r.date, r.amount]),
      [["2026-08-02", -45_000], ["2026-08-08", 4_500_000]],
    );
  });

  test("headings, totals and footers are not transactions", () => {
    for (const text of [HDFC, ICICI, AXIS, SBI]) {
      const result = parseStatementText(text);
      for (const record of result.records) {
        assert.ok(!/computer generated|^page|^total/i.test(record.narration), record.narration);
      }
    }
  });

  test("IL3 · a row that looked like a transaction and did not parse is reported", () => {
    const broken = `AXIS BANK LTD
Tran Date  Chq No  Particulars  Debit  Credit  Balance
04-08-2026  MANGLED ROW WITH NO FIGURES AT ALL`;

    const result = parseStatementText(broken);
    assert.equal(result.records.length, 0);
    assert.equal(result.errors.length, 1);
    // Never swallowed: the offending row comes back with it.
    assert.ok(result.errors[0]!.cells.join(" ").includes("MANGLED"));
  });

  test("a password-protected statement opens, end to end", () => {
    // The whole chain: RC4 decryption, text extraction with its column
    // positions, bank recognition, and the rows.
    const result = parseStatementPdf(STATEMENTS.hdfcEncrypted, STATEMENT_PASSWORD);
    assert.equal(result.bank!.id, "hdfc");
    assert.deepEqual(
      result.records.map((r) => [r.date, r.amount]),
      [["2026-08-03", -45_000], ["2026-08-05", 14_500_000], ["2026-08-11", -145_050]],
    );
  });

  test("PR5 · a wrong password fails by name, never as an empty statement", () => {
    // The failure that matters: garbage that parses to zero rows looks exactly
    // like a successful import of nothing.
    assert.throws(
      () => parseStatementPdf(STATEMENTS.hdfcEncrypted, "not-the-password"),
      WrongPassword,
    );
  });

  test("the extracted text is returned, so an unrecognised file can be mapped", () => {
    const result = parseStatementText("Unknown Bank\n01/08/2026  Something  10.00  20.00  30.00");
    assert.equal(result.bank, null);
    assert.ok(result.text.includes("Unknown Bank"));
  });
});

describe("04 §3.3 · column alignment is what makes an empty column readable", () => {
  test("the header's column spans are found", () => {
    const header = readHeader(HDFC.split("\n"))!;
    assert.ok(header, "HDFC's table header should be recognised");
    assert.ok(header.debit && header.credit && header.balance);
    // Withdrawal is left of Deposit is left of Balance, which is the fact the
    // whole assignment depends on.
    assert.ok(header.debit!.start < header.credit!.start);
    assert.ok(header.credit!.start < header.balance!.start);
  });

  test("a figure is assigned by which column it sits under, not by proximity", () => {
    /*
     * This is the case that decides whether a salary is income or an expense.
     * In the ICICI layout the deposit column begins a few characters past the
     * end of the withdrawal heading, so "which figure is nearest the
     * withdrawal column?" claims the deposit and inverts the transaction.
     */
    const result = parseStatementText(ICICI);
    const salary = result.records.find((r) => /SALARY/i.test(r.narration))!;
    assert.ok(salary.amount > 0, "a salary is money in");
  });

  test("an empty column is not mistaken for the one beside it", () => {
    // Both HDFC rows have exactly two figures each — one money column plus a
    // balance. Nothing but position distinguishes them.
    const result = parseStatementText(HDFC);
    const out = result.records.find((r) => /SWIGGY/i.test(r.narration))!;
    const inward = result.records.find((r) => /SALARY/i.test(r.narration))!;
    assert.ok(out.amount < 0);
    assert.ok(inward.amount > 0);
  });
});

describe("04 §3.3 · the details that invert a transaction if wrong", () => {
  test("a two-digit year is this century", () => {
    // 01/08/26 as 1926 puts the transaction a century out, where no dedupe
    // tier will ever find it.
    assert.equal(parseStatementDate("01/08/26"), "2026-08-01");
    assert.equal(parseStatementDate("01/08/2026"), "2026-08-01");
    assert.equal(parseStatementDate("1-Aug-2026"), "2026-08-01");
    assert.equal(parseStatementDate("2 Aug 2026"), "2026-08-02");
  });

  test("day and month are not swapped", () => {
    // Indian statements are DD/MM. Reading 03/08 as 8 March is the single most
    // damaging thing this parser could do quietly.
    assert.equal(parseStatementDate("03/08/2026"), "2026-08-03");
    assert.equal(parseStatementDate("13/08/2026"), "2026-08-13");
  });

  test("an impossible date is refused rather than coerced", () => {
    assert.equal(parseStatementDate("32/08/2026"), null);
    assert.equal(parseStatementDate("01/13/2026"), null);
    assert.equal(parseStatementDate("not a date"), null);
  });

  test("Cr, Dr and brackets", () => {
    assert.deepEqual(parseStatementAmount("1,450.50"), { value: 1450.5, credit: false });
    assert.deepEqual(parseStatementAmount("1,450.50 Cr"), { value: 1450.5, credit: true });
    assert.deepEqual(parseStatementAmount("1,450.50 Dr"), { value: 1450.5, credit: false });
    assert.deepEqual(parseStatementAmount("(1,450.50)"), { value: 1450.5, credit: false });
    assert.equal(parseStatementAmount("-"), null);
    assert.equal(parseStatementAmount(""), null);
  });

  test("lakh-scale grouping survives", () => {
    assert.deepEqual(parseStatementAmount("1,45,000.00"), { value: 145000, credit: false });
  });
});

describe("04 §3.4 · which sender means which institution", () => {
  test("the household's own statement senders are recognised", () => {
    assert.equal(senderFor("Emailstatements.cards@hdfcbank.bank.in")!.bank, "hdfc");
    assert.equal(senderFor("estatement@icici.bank.in")!.bank, "icici");
    assert.equal(senderFor("credit_cards@icici.bank.in")!.bank, "icici");
    assert.equal(senderFor("cc.statements@axis.bank.in")!.bank, "axis");
    assert.equal(senderFor("cbssbi.cas@alerts.sbi.bank.in")!.bank, "sbi");
    assert.equal(senderFor("Statements@sbicard.com")!.bank, "sbi");
  });

  test("a CAS is routed to the portfolio importer, not to the bank one", () => {
    const cas = senderFor("eCAS@cdslstatement.com")!;
    assert.equal(cas.bank, null);
    assert.match(cas.what, /portfolio/i);
  });

  test("an unknown sender is null", () => {
    assert.equal(senderFor("someone@example.com"), null);
  });

  test("a lookalike domain does not match", () => {
    // The patterns are anchored, so `evil-icici.bank.in.example.com` cannot
    // impersonate a bank into being trusted.
    assert.equal(senderFor("estatement@icici.bank.in.example.com"), null);
    assert.equal(senderFor("notestatement@icici.bank.in"), null);
  });
});
