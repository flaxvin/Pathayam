import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { csvCell } from "./csv.ts";

describe("SECURITY-OPS-20 · a CSV cell never runs as a formula", () => {
  test("text a spreadsheet would evaluate is marked as text", () => {
    for (const lead of ["=", "+", "-", "@", "\t", "\r"]) {
      const cell = csvCell(`${lead}SUM(A1:A9)`);
      assert.ok(cell.startsWith("'") || cell.startsWith(`"'`), `${JSON.stringify(lead)} → ${cell}`);
    }
    assert.equal(csvCell('=HYPERLINK("http://x.example","go")'), `"'=HYPERLINK(""http://x.example"",""go"")"`);
  });

  test("numbers, ordinary text and empties are unchanged", () => {
    assert.equal(csvCell(-1250.5), "-1250.5");
    assert.equal(csvCell("-450"), "-450");
    assert.equal(csvCell("+12"), "+12");
    assert.equal(csvCell("Swiggy"), "Swiggy");
    assert.equal(csvCell(null), "");
    assert.equal(csvCell(undefined), "");
    assert.equal(csvCell("milk, bread"), '"milk, bread"');
  });

  test("a bare carriage return is quoted, not left to split the row", () => {
    assert.equal(csvCell("a\rb"), '"a\rb"');
  });
});

test("SECURITY-OPS-20 · the query CSV goes through it too", async () => {
  const { rowsToCsv } = await import("../domain/reports.ts");
  const row = {
    date: "2026-08-14", account: "HDFC", payee: "-Refund", category: null, memo: null,
    amount: -45000, owner: "Ravi", cleared: 0, raw_narration: "=1+1",
  } as unknown as Parameters<typeof rowsToCsv>[0][number];
  const line = rowsToCsv([row]).split("\n")[1]!;
  assert.equal(line, "2026-08-14,HDFC,'-Refund,,,-450,Ravi,0,'=1+1");
});
