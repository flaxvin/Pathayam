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
    assert.equal(salary.source, "EXAMPLE SOFTWARE LTD", "the TAN is left out");
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
      "Outward foreign remittance/purchase of foreign currency",
      ["SR. NO.", "INFORMATION CODE", "INFORMATION DESCRIPTION", "INFORMATION SOURCE", "COUNT", "AMOUNT"],
      ["4", "TCS-206CQ", "Remittance under LRS (u/s 206C(1G(a)))", "SAMPLE BANK (MUMS00000B)", "1", "8,00,000"],
      ["SR. NO.", "QUARTER", "DATE OF PAYMENT/CREDIT", "AMOUNT PAID/CREDITED", "TCS COLLECTED", "TCS DEPOSITED", "STATUS"],
      ["1", "Q2(Jul-Sep)", "20/07/2025", "8,00,000", "1,60,000", "1,60,000", "Active"],
      "Payment to contractors",
      ["SR. NO.", "INFORMATION CODE", "INFORMATION DESCRIPTION", "INFORMATION SOURCE", "COUNT", "AMOUNT"],
      ["5", "TDS-194C", "Payment to contractors", "EXAMPLE BUILDERS LTD (MUME00000D)", "1", "1,00,000"],
      ["SR. NO.", "QUARTER", "DATE OF PAYMENT/CREDIT", "AMOUNT PAID/CREDITED", "TDS DEDUCTED", "TDS DEPOSITED", "STATUS"],
      ["1", "Q2(Jul-Sep)", "20/08/2025", "1,00,000", "1,000", "1,000", "Active"],
      ["SR. NO.", "INFORMATION CODE", "INFORMATION DESCRIPTION", "INFORMATION SOURCE", "COUNT", "AMOUNT"],
      ["6", "Something unlisted", "EXAMPLE TRUST (MUME00000E)", "1", "20,000"],
      ["SR. NO.", "QUARTER", "DATE OF PAYMENT/CREDIT", "AMOUNT PAID/CREDITED", "TDS DEDUCTED", "TDS DEPOSITED", "STATUS"],
      ["1", "Q2(Jul-Sep)", "20/08/2025", "20,000", "2,000", "2,000", "Active"],
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
    const sale = byCode(s, "SFT-17-OTU(M)")!;
    assert.equal(sale.category, "securities-sale");
    assert.equal(sale.amount, 2_50_000_00);
    assert.equal(sale.tds, 0);
  });

  test("a category the estimate does not model is kept as unread, not guessed into income", () => {
    const rent = byCode(s, "SFT-004")!;
    assert.equal(rent.category, "unread");
    assert.match(rent.label, /^Rent received/);
  });
});

describe("TAX-AIS · what is not read", () => {
  test("a part it does not read is counted, not parsed", () => {
    const s = parseAisText(aisText(sampleAis()));
    assert.deepEqual(s.notRead, [{ part: "Payment of taxes", lines: 1 }]);
  });

  test("a line of an unrecognised shape inside a known part is counted as not read", () => {
    const s = parseAisText(aisText(sampleAis({ extra: [["6", "SFT-099", "no amount here"], ["7", "SFT-098", "ONE", "TWO", "THREE"]] })));
    assert.deepEqual(s.notRead.find((n) => n.part === "SFT information"), { part: "SFT information", lines: 2 });
  });

  test("an unknown part's lines are counted as not read, not read into the part before it", () => {
    const lines = sampleAis();
    const at = lines.findIndex((l) => typeof l === "string" && /payment of taxes/i.test(l));
    lines.splice(at, 0, "Part B9 - Something New", ["SR. NO.", "INFORMATION CODE", "INFORMATION DESCRIPTION", "INFORMATION SOURCE", "COUNT", "AMOUNT"], ["1", "SFT-200", "Interest from somewhere", "BANK", "1", "1.00"]);
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
    // SFT-018 is a purchase of fund units on a real AIS, not a dividend.
    assert.equal(categoryOf("SFT-18(PUR)", "Purchase of mutual funds (SFT - 018)"), "unread");
    assert.equal(categoryOf(null, "Purchase of securities and units of mutual funds"), "unread");
    assert.equal(categoryOf(null, "Cash deposits"), "unread");
  });
});

describe("TAX-AIS · the layout of a real statement (synthetic figures)", () => {
  test("the category heading decides where the description is vague", () => {
    assert.equal(categoryOf("SFT-016(SB)", "Interest income (SFT-016) - Savings", "Interest from savings bank"), "interest-savings");
    assert.equal(categoryOf("SFT-016(TD)", "Interest income (SFT-016) - Term Deposit", "Interest from deposit"), "interest-deposit");
    assert.equal(categoryOf("SFT-17-OTU(M)", "Sale of other unit (Depository)", "Sale of securities and units of mutual fund"), "securities-sale");
    assert.equal(categoryOf("SFT-016(SB)", "Interest income (SFT-016) - Savings"), "interest-savings", "the code, with no heading");
  });

  test("2026-27 onward: 'Tax Year (T.Y.)' and the Income-tax Act, 2025's codes", () => {
    const lines = sampleAis({ fy: "2026-27", taxYear: true });
    const at = lines.findIndex((l) => typeof l === "string" && /^Dividend$/.test(l));
    lines.splice(at, 0,
      "Interest from deposit",
      ["SR. NO.", "INFORMATION CODE", "INFORMATION DESCRIPTION", "INFORMATION SOURCE", "COUNT", "AMOUNT"],
      // A real line whose long description runs into the source with one space.
      ["9", "TDS-393(1)[Table: S.No. 5(ii) & 5(iii)]", "Interest other than \"Interest on Securities\" received EXAMPLE JEWELLERS LIMITED (BLRE00000Z)", "3", "77"],
      "(Section 393(1) [Table: S.No. 5(ii) & 5(iii)])",
      ["SR. NO.", "QUARTER", "DATE OF PAYMENT/CREDIT", "AMOUNT PAID/CREDITED", "TDS DEDUCTED", "TDS DEPOSITED", "STATUS"],
      ["1", "Q2(Jul-Sep)", "30/09/2026", "77", "7", "7", "Active"],
    );
    const s = parseAisText(aisText(lines));
    assert.equal(s.fy, 2026);
    const l = s.lines.find((x) => /^TDS-393/.test(x.code ?? ""))!;
    assert.equal(l.source, "EXAMPLE JEWELLERS LIMITED");
    assert.match(l.label, /^Interest other than/);
    assert.equal(l.category, "interest-deposit");
    assert.equal(l.tds, 7_00);
  });

  test("a note naming another year does not set the year", () => {
    const lines = sampleAis({ fy: "2024-25" });
    lines.splice(2, 0, "Note - For financial year 2022-23 and earlier, details of tax payments are available in Form 26AS.");
    assert.equal(parseAisText(aisText(lines)).fy, 2024);
  });

  test("the year is found in the page band when the heading lacks it", () => {
    const text = "Annual Information Statement (AIS)\nPart A - General Information\nPAN    Name    Financial Year\nABCDE1234F    TEST PERSON    2025-26\n";
    assert.equal(parseAisText(text).fy, 2025);
  });

  test("the page band and footer are furniture: no name, no counts as not read", () => {
    const s = parseAisText(aisText(sampleAis()));
    assert.deepEqual(s.notRead, [{ part: "Payment of taxes", lines: 1 }]);
    assert.doesNotMatch(JSON.stringify(s.lines), /TEST PERSON|000000000000/);
  });

  test("a detail row that is not Active does not add to TDS", () => {
    const lines = sampleAis();
    const at = lines.findIndex((l) => Array.isArray(l) && l[0] === "4" && l[1] === "Q1(Apr-Jun)");
    lines.splice(at + 1, 0, ["5", "Q1(Apr-Jun)", "30/04/2025", "3,00,000", "20,000", "20,000", "Inactive"]);
    const s = parseAisText(aisText(lines));
    assert.equal(byCode(s, "TDS-192")!.tds, 80_000_00);
  });

  test("Part B7's salary is read, and the summary counts one employer's salary once", () => {
    const s = parseAisText(aisText(sampleAis()));
    const b7 = s.lines.find((l) => l.section === "other")!;
    assert.equal(b7.category, "salary");
    assert.equal(b7.source, "EXAMPLE SOFTWARE LTD");
    assert.equal(b7.tds, 0);
  });
});
