import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseStatementText, parseStatementPdf, openStatement, parseStatementDate,
  parseStatementAmount, detectBank, senderFor, readHeader, BANKS, WrongPassword,
} from "./pdf-statements.ts";
import { STATEMENTS, STATEMENT_PASSWORD, STATEMENT_IDENTITY } from "./statements.test-data.ts";
import { passwordCandidates, describeCandidate } from "./statement-passwords.ts";

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

  test("`10` §3.6 · a saved identity opens it with nobody present", () => {
    // The whole point of the reversal: no human types anything. "Ravi Kumar"
    // born 01/01/1970 gives RAVI0101, which is the password this file has.
    const result = openStatement(
      STATEMENTS.hdfcEncrypted,
      passwordCandidates(STATEMENT_IDENTITY, "hdfc"),
    );
    assert.ok(result, "the derived candidates should include the right one");
    assert.equal(result!.parse.bank!.id, "hdfc");
    assert.equal(result!.parse.records.length, 3);
    // What opened it is described, never quoted back.
    assert.equal(describeCandidate(result!.candidate, STATEMENT_IDENTITY),
      "your name and date of birth");
  });

  test("an identity that derives nothing useful does not open it", () => {
    const wrong = { name: "Someone Else", pan: null, dob: "02021980" };
    assert.equal(openStatement(STATEMENTS.hdfcEncrypted, passwordCandidates(wrong)), null);
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

  // "1,200.00Cr" with the marker attached: `\bcr` never matched after a digit,
  // so the cell was unreadable here while CSV read it as ₹120 crore. Both now
  // agree on a ₹1,200 credit.
  test("a Cr or Dr marker attached to the figure is still a marker", () => {
    assert.deepEqual(parseStatementAmount("1,200.00Cr"), { value: 1200, credit: true });
    assert.deepEqual(parseStatementAmount("1200CR"), { value: 1200, credit: true });
    assert.deepEqual(parseStatementAmount("1,200.00Dr"), { value: 1200, credit: false });
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

/**
 * The traps real statements set.
 *
 * Every case below cost a broken parse against an actual file, and each is
 * written as the smallest text that reproduces it. They are synthetic — no
 * real statement is in this repository — but the *shapes* are copied exactly
 * from what the reader produced.
 */
describe("04 §3.3 · what real statements do that invented ones do not", () => {
  test("narration wraps around the dated line, not merely above it", () => {
    // Union Bank wraps a cell across three lines with the date in the middle,
    // so the fragment above and the fragment below belong to the same row.
    // Attaching everything to the row above — the obvious rule — glues each
    // row's opening fragment onto its predecessor and puts the payee on the
    // wrong transaction.
    const text = `Union Bank of India
 SI    Date        Particulars      Chq Num    Withdrawal    Deposit      Balance
Opening Balance : 12,480.55
              UPIAR/400111222888/DR/
  1   11-02-2026                               855.00                    11,625.55
              CRED/UTIB/cred.utility@a
              NEFT:RAVI KUMAR
  2   25-02-2026                                            30,000.00    41,625.55`;

    const result = parseStatementText(text);
    assert.equal(result.records.length, 2);
    assert.match(result.records[0]!.narration, /UPIAR\/400111222888/);
    assert.match(result.records[0]!.narration, /CRED\/UTIB/);
    assert.match(result.records[1]!.narration, /NEFT:RAVI KUMAR/);
    assert.ok(!result.records[1]!.narration.includes("CRED/UTIB"));
  });

  test("a row may open with a serial number before the date", () => {
    const result = parseStatementText(`Union Bank of India
 SI    Date        Particulars   Withdrawal   Deposit   Balance
Opening Balance : 1,000.00
  1   11-02-2026  SOMETHING       100.00                 900.00`);
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0]!.amount, -10_000);
  });

  test("a date followed by a time still reads", () => {
    // HDFC's card prints "17/03/2026| 23:08", and the time must not end up in
    // the payee either.
    const result = parseStatementText(`HDFC BANK Credit Card
       DATE & TIME          TRANSACTION DESCRIPTION            AMOUNT
       17/03/2026| 23:08    PYU*Swiggy Food Bangalore          491.00`);
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0]!.date, "2026-03-17");
    assert.ok(!result.records[0]!.narration.includes("23:08"));
    assert.match(result.records[0]!.narration, /Swiggy/);
  });

  test("a single space between date and narration is still two columns", () => {
    // YES Bank uses one space, so splitting on whitespace runs never separates
    // them and the date is never found.
    const result = parseStatementText(`YES BANK Credit Card
Date Description Amount
15/02/2026  UPI_ZOOMCAR IND - Ref No: RT400111222999000111222   Business Services   4,137.00 Dr`);
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0]!.amount, -413_700);
    assert.match(result.records[0]!.narration, /ZOOMCAR/);
  });

  test("Cr and Dr decide the sign when there is no balance column", () => {
    const result = parseStatementText(`YES BANK
Date Description Amount
15/02/2026  A PURCHASE    100.00 Dr
16/02/2026  A REFUND       40.00 Cr`);
    assert.deepEqual(result.records.map((r) => r.amount), [-10_000, 4_000]);
  });

  test("a leading plus marks a credit on a card", () => {
    const result = parseStatementText(`HDFC BANK Credit Card
DATE & TIME  TRANSACTION DESCRIPTION  AMOUNT
18/03/2026| 00:00   10% Swiggy Cashback          +  1,500.00
18/03/2026| 00:00   Swiggy Cashback_Reversal        21.70`);
    assert.deepEqual(result.records.map((r) => r.amount), [150_000, -2_170]);
  });

  test("a mis-encoded rupee sign does not become the payee", () => {
    /*
     * HDFC embeds the rupee sign in a font whose encoding maps it to 0x43, so
     * a faithful extractor reports "C 491.00" where the page shows "₹ 491.00".
     * Left attached, the cell stops looking like money — so it lands in the
     * payee and the row's sign is then decided by the wrong rule.
     */
    const result = parseStatementText(`HDFC BANK Credit Card
DATE & TIME  TRANSACTION DESCRIPTION  AMOUNT
17/03/2026| 23:08   ZEPTO MARKETPLACE Bangalore      C  2,319.95`);
    assert.equal(result.records[0]!.amount, -231_995);
    assert.equal(result.records[0]!.narration, "ZEPTO MARKETPLACE Bangalore");
  });

  test("a trailing branch code is not a balance", () => {
    // Axis prints "1460" after the balance. Reading it as the running balance
    // corrupts every row after it.
    const result = parseStatementText(`AXIS BANK LTD
 Tran Date  Particulars   Debit   Credit   Balance   Init.Br
OPENING BALANCE                                      1,000.00
 01-12-2025  A PAYMENT      640.00                     360.00 1460`);
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0]!.amount, -64_000);
  });

  test("an appendix that looks like transactions is not imported", () => {
    // Union Bank ends with LINKED LOAN & ADVANCES, whose rows carry a date and
    // a balance. Importing them adds an ₹18 lakh movement that never happened.
    const result = parseStatementText(`Union Bank of India
 SI  Date      Particulars   Withdrawal   Deposit   Balance
Opening Balance : 1,000.00
  1  11-02-2026  A PAYMENT     100.00                900.00
LINKED LOAN & ADVANCES
  1  EL008  7494XXXXXXX0018  04-08-2020  25,51,000.00  18,22,371.00`);
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0]!.amount, -10_000);
  });

  test("words the bank prints above its table do not end it", () => {
    /*
     * "Summary", "Closing Balance" and "IMPORTANT INFORMATION" all appear
     * *above* the transactions in at least one real statement — Axis leads
     * with a summary block and a closing-balance footnote, HDFC's card with
     * IMPORTANT INFORMATION. Treating any of them as the end of the table
     * silently discarded every row of those files.
     */
    const result = parseStatementText(`AXIS BANK LTD
Summary
^Amount represents Closing Balance as on month end.
IMPORTANT INFORMATION
 Tran Date  Particulars  Debit  Credit  Balance
OPENING BALANCE                               1,000.00
 01-07-2026  A PAYMENT    100.00              900.00`);
    assert.equal(result.records.length, 1);
  });

  test("a letterhead below the first row is still a letterhead", () => {
    // Axis's Relationship Statement prints a transaction four lines in and
    // names the bank below it.
    const text = `Statement for the period
 01-07-2026  A PAYMENT   100.00   900.00
AXIS BANK LTD
 Tran Date  Particulars  Debit  Credit  Balance`;
    assert.equal(detectBank(text)!.id, "axis");
  });

  test("a bank whose name is split by kerning is still recognised", () => {
    // Per-glyph positioning makes the extractor report exactly what is there:
    // "A XIS BANK", "R elationship Statement".
    assert.equal(detectBank("R elationship Statement\nA XIS BANK LTD")!.id, "axis");
  });

  test("an IFSC prefix identifies the bank when nothing else does", () => {
    // A real Axis statement's letterhead is the customer's postal address.
    const text = `RAVI KUMAR
C705 MEDITERRANEA
THANE                        IFSC Code :UTIB0001460`;
    assert.equal(detectBank(text)!.id, "axis");
  });
});

describe("04 §3.3 · things that look like transactions and are not", () => {
  test("a statement period is not a ₹3,00,000 purchase", () => {
    /*
     * YES Bank heads its table with the period and the credit limit on one
     * line. It starts with a date and ends with a figure, so it parses as a
     * transaction — and the largest one on the statement.
     */
    const result = parseStatementText(`YES BANK Credit Card
              15/02/2026 To 14/03/2026        Credit Limit:      Rs. 3,00,000.00
15/02/2026  UPI_ZOOMCAR IND - Ref No: RT2604   Business Services   4,137.00 Dr`);

    assert.equal(result.records.length, 1);
    assert.equal(result.records[0]!.amount, -413_700);
  });

  test("a specimen table in the closing legend is not nine failed rows", () => {
    /*
     * RBL ends its card statement with "Know about charges" and a Sample
     * Transaction table — dated rows, real-looking amounts, from 2018. Every
     * one of them surfaced as "columns could not be read".
     */
    const result = parseStatementText(`RBL Bank Credit Card Statement
Date   Transaction Details   Amount
21-Apr-2026   PYU*Swiggy Food Bangalore IND   338.00 Dr
Know about charges on Credit Card
Sample Transaction
Date           Transaction
12-Dec-18      Purchase of Groceries
26-Dec-18      Purchase of clothes
02-Jan-19      Membership Fee + GST`);

    assert.equal(result.records.length, 1);
    assert.equal(result.errors.length, 0);
  });

  test("two dates in a row are fine when they are not a range", () => {
    // SBI prints a transaction date and a value date, and "TO TRANSFER" in the
    // narration — none of which makes the row a period header.
    const result = parseStatementText(`STATE BANK OF INDIA
Txn Date   Value Date   Description   Ref No.   Debit   Credit   Balance
2 Aug 2026   2 Aug 2026   TO TRANSFER-UPI/DR/SWIGGY   431202   450.00      9,550.00`);
    assert.equal(result.records.length, 1);
  });

  test("a summary field in the table's band is not part of a payee", () => {
    // Statements pack labels into the same vertical band as the rows. Each one
    // that slips through is glued onto a real transaction's payee, where it
    // reaches payee matching, rules and dedupe.
    const result = parseStatementText(`AXIS BANK LTD
 Tran Date  Particulars   Debit   Credit   Balance
OPENING BALANCE                                    1,000.00
              No. Opening Balance 4,19,620.65
 01-07-2026   A REAL PAYMENT      100.00            900.00`);

    assert.equal(result.records.length, 1);
    assert.equal(result.records[0]!.narration, "A REAL PAYMENT");
  });

  test("a letterhead is not glued to the first transaction", () => {
    const result = parseStatementText(`HDFC BANK Credit Card
RAVI KUMAR [CKYC ID : 90001234567890 ]
DATE & TIME  TRANSACTION DESCRIPTION  AMOUNT
17/03/2026| 23:08   ZEPTO MARKETPLACE Bangalore      C  2,319.95`);
    assert.equal(result.records[0]!.narration, "ZEPTO MARKETPLACE Bangalore");
  });
});
