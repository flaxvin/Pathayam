/**
 * TAX-AIS · Reading an Annual Information Statement PDF.
 *
 * Every file here is synthetic (src/import/ais.test-data.ts): an invented PAN
 * and invented figures, in the layout the reader assumes — which is itself
 * [unverified] against a real AIS, so these tests pin the reading, not the
 * department's format.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseAisPdf, parseAisText, aisPassword, categoryOf, WrongPassword, TCS_PART } from "./ais.ts";
import { aisPdf, aisText, sampleAis, AIS_PAN, AIS_DOB, AIS_PASSWORD } from "./ais.test-data.ts";
import { Refusal } from "../core/refusal.ts";

const byCode = (s: ReturnType<typeof parseAisText>, code: string) => s.lines.find((l) => l.code === code);

describe("TAX-AIS · the password", () => {
  test("is the PAN in small letters, then the date of birth as DDMMYYYY (the department's rule)", () => {
    assert.equal(aisPassword("AAAAA1234A", "21011991"), "aaaaa1234a21011991");
    assert.equal(aisPassword(AIS_PAN, AIS_DOB), AIS_PASSWORD);
  });

  test("an encrypted AIS opens with it, end to end", () => {
    const s = parseAisPdf(aisPdf(sampleAis(), AIS_PASSWORD), AIS_PASSWORD);
    assert.equal(s.fy, 2025);
    assert.equal(s.pan, AIS_PAN);
    assert.ok(s.lines.length >= 7);
  });

  test("a wrong password fails by name, never as an empty statement", () => {
    assert.throws(() => parseAisPdf(aisPdf(sampleAis(), AIS_PASSWORD), "ABCDE1234F01011980"), WrongPassword);
    assert.throws(() => parseAisPdf(aisPdf(sampleAis(), AIS_PASSWORD), ""), WrongPassword);
  });
});

describe("TAX-AIS · Part B1, TDS/TCS information", () => {
  const s = parseAisText(aisText(sampleAis()));

  test("salary is read with the TDS deposited, summed over its quarters", () => {
    const salary = byCode(s, "TDS-192")!;
    assert.equal(salary.category, "salary");
    assert.equal(salary.section, "tds");
    assert.equal(salary.amount, 12_00_000_00);
    assert.equal(salary.tds, 80_000_00);
    assert.equal(salary.source, "EXAMPLE SOFTWARE LTD (BLRE00000A)");
  });

  test("194A interest is deposit interest, as the Handbook files it, with its TDS", () => {
    const interest = byCode(s, "TDS-194A")!;
    assert.equal(interest.category, "interest-deposit");
    assert.equal(interest.tds, 5_000_00);
  });

  test("194 is a dividend", () => {
    const dividend = byCode(s, "TDS-194")!;
    assert.equal(dividend.category, "dividend");
    assert.equal(dividend.amount, 8_000_00);
    assert.equal(dividend.tds, 800_00);
  });
});

describe("REV-2 · TCS and uncategorised lines never feed TDS", () => {
  const withTcs = () => {
    const lines = sampleAis();
    const at = lines.findIndex((l) => typeof l === "string" && /Part B2/.test(l));
    lines.splice(at, 0,
      ["4", "TCS-206CQ", "Remittance under LRS for purposes other than education or medical treatment", "SAMPLE BANK (MUMS00000B)", "1", "8,00,000.00"],
      ["", "Q2", "20/07/2025", "8,00,000.00", "1,60,000.00", "1,60,000.00"],
      ["5", "TDS-194C", "Payment to contractors", "EXAMPLE BUILDERS LTD (MUME00000D)", "1", "1,00,000.00"],
      ["", "Q2", "20/08/2025", "1,00,000.00", "1,000.00", "1,000.00"],
      ["6", "Something unlisted", "EXAMPLE TRUST (MUME00000E)", "1", "20,000.00"],
      ["", "Q2", "20/08/2025", "20,000.00", "2,000.00", "2,000.00"],
    );
    return parseAisText(aisText(lines));
  };

  test("a TCS-206C line is not read: no line, no TDS, counted as TCS", () => {
    const s = withTcs();
    assert.equal(s.lines.find((l) => /^TCS-/.test(l.code ?? "")), undefined);
    assert.equal(s.lines.reduce((t, l) => t + l.tds, 0), 80_000_00 + 5_000_00 + 800_00 + 1_000_00);
    assert.deepEqual(s.notRead.find((n) => n.part === TCS_PART), { part: TCS_PART, lines: 1 });
  });

  test("a TDS-coded line of an unread kind keeps its TDS; one with no code does not", () => {
    const s = withTcs();
    assert.equal(byCode(s, "TDS-194C")!.tds, 1_000_00);
    const odd = s.lines.find((l) => l.label === "Something unlisted")!;
    assert.equal(odd.category, "unread");
    assert.equal(odd.tds, 0);
  });
});

describe("TAX-AIS · Part B2, SFT information", () => {
  const s = parseAisText(aisText(sampleAis()));

  test("savings and deposit interest are told apart by their description", () => {
    assert.equal(byCode(s, "SFT-016(SB)")!.category, "interest-savings");
    assert.equal(byCode(s, "SFT-016(SB)")!.amount, 4_200_00);
    assert.equal(byCode(s, "SFT-016(TD)")!.category, "interest-deposit");
  });

  test("a dividend and a sale of securities", () => {
    assert.equal(byCode(s, "SFT-015")!.category, "dividend");
    const sale = byCode(s, "SFT-017")!;
    assert.equal(sale.category, "securities-sale");
    assert.equal(sale.amount, 2_50_000_00);
    assert.equal(sale.tds, 0);
  });

  test("a category the estimate does not model is kept as unread, not guessed into income", () => {
    const rent = byCode(s, "SFT-004")!;
    assert.equal(rent.category, "unread");
    assert.equal(rent.label, "Rent received");
  });
});

describe("TAX-AIS · what is not read", () => {
  test("a part it does not read is counted, not parsed", () => {
    const s = parseAisText(aisText(sampleAis()));
    assert.deepEqual(s.notRead, [{ part: "Payment of taxes", lines: 1 }]);
  });

  test("a line of an unrecognised shape inside a known part is counted as not read", () => {
    const s = parseAisText(aisText(sampleAis({ extra: [["something", "odd"], ["6", "SFT-099", "no amount here"]] })));
    assert.deepEqual(s.notRead.find((n) => n.part === "SFT information"), { part: "SFT information", lines: 2 });
  });

  test("an unknown part's lines are counted as not read, not read into the part before it", () => {
    const lines = sampleAis();
    const at = lines.findIndex((l) => typeof l === "string" && /Payment of Taxes/.test(l));
    lines.splice(at, 0, "Part B9 - Something New", ["1", "SFT-200", "Interest from somewhere", "BANK", "1", "1.00"]);
    const s = parseAisText(aisText(lines));
    assert.equal(byCode(s, "SFT-200"), undefined);
    assert.deepEqual(s.notRead.find((n) => n.part === "A part this app does not know")?.lines, 1);
  });

  test("Part A is never read into anything returned: no name, no address", () => {
    const s = parseAisText(aisText(sampleAis()));
    const out = JSON.stringify({ lines: s.lines, notRead: s.notRead });
    assert.doesNotMatch(out, /TEST PERSON|EXAMPLE ROAD|ABCDE1234F/);
  });
});

describe("TAX-AIS · refusals", () => {
  test("a PDF that is not an AIS", () => {
    assert.throws(() => parseAisText("HDFC BANK\nStatement of account"), Refusal);
  });

  test("no financial year", () => {
    assert.throws(
      () => parseAisText("Annual Information Statement\nPart A - General Information\nPAN  ABCDE1234F"),
      /which financial year/,
    );
  });

  test("an assessment year is read as the year before", () => {
    const s = parseAisText("Annual Information Statement\nAssessment Year 2026-27\nPAN  ABCDE1234F");
    assert.equal(s.fy, 2025);
  });

  test("no PAN", () => {
    assert.throws(() => parseAisText("Annual Information Statement\nFinancial Year 2025-26"), /no PAN/);
  });

  test("the year comes from the file", () => {
    assert.equal(parseAisText(aisText(sampleAis({ fy: "2024-25" }))).fy, 2024);
  });
});

describe("TAX-AIS · categories", () => {
  test("by description first, then by code", () => {
    assert.equal(categoryOf(null, "Salary"), "salary");
    assert.equal(categoryOf("TDS-192", "Something"), "salary");
    assert.equal(categoryOf(null, "Interest from others"), "interest-other");
    assert.equal(categoryOf(null, "Interest from income tax refund"), "interest-other");
    assert.equal(categoryOf(null, "Dividend received"), "dividend");
    assert.equal(categoryOf("SFT-018", "Income from units"), "dividend");
    assert.equal(categoryOf(null, "Purchase of securities and units of mutual funds"), "unread");
    assert.equal(categoryOf(null, "Cash deposits"), "unread");
  });
});
