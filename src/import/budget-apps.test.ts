/**
 * IMPORT-1 · Reading YNAB's register export and Actual Budget's transaction
 * export: recognising them, their dates and amounts, transfers and splits.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseBudgetApp, detectBudgetApp, parseAppAmount, decimalSeparatorOf, appDateOrder,
} from "./budget-apps.ts";
import { matchEnvelope, planBudgetAppImport, type Envelope } from "./budget-app-import.ts";
import { parseDelimited } from "./csv.ts";
import {
  YNAB_DAY_FIRST, YNAB_MONTH_FIRST, YNAB_AMBIGUOUS, YNAB_MIXED, YNAB_DECIMAL_COMMA, ACTUAL_EXPORT,
} from "./budget-apps.test-data.ts";

describe("IMPORT-1 · recognising the file", () => {
  test("YNAB and Actual are told apart by their headers; a bank statement is neither", () => {
    assert.equal(detectBudgetApp(parseDelimited(YNAB_DAY_FIRST))?.app, "ynab");
    assert.equal(detectBudgetApp(parseDelimited(ACTUAL_EXPORT))?.app, "actual");
    assert.equal(detectBudgetApp(parseDelimited("Date,Narration,Withdrawal Amt.,Deposit Amt.\n01-08-2026,X,1,")), null);
    assert.equal(parseBudgetApp("Date,Narration,Amount\n02-09-2026,SHOP,-100.00"), null);
  });

  test("YNAB 4's Master and Sub Category columns are read too", () => {
    const parse = parseBudgetApp([
      "Account,Flag,Check Number,Date,Payee,Category,Master Category,Sub Category,Memo,Outflow,Inflow,Cleared,Running Balance",
      "ZZ Savings,,,15/09/2026,ZZ Kirana,Everyday: Groceries,Everyday,Groceries,,₹100.00,₹0.00,C,₹0.00",
    ].join("\n"))!;
    assert.deepEqual(parse.transactions[0]!.category, { group: "Everyday", name: "Groceries" });
  });
});

describe("IMPORT-1 · amounts", () => {
  test("a currency symbol of any kind is dropped, and grouping with it", () => {
    assert.equal(parseAppAmount("₹1,250.50"), 125050);
    assert.equal(parseAppAmount("$12.50"), 1250);
    assert.equal(parseAppAmount("Rs. 1,23,456.00"), 12345600);
    assert.equal(parseAppAmount("-₹40.00"), -4000);
    assert.equal(parseAppAmount("₹-40.00"), -4000);
    assert.equal(parseAppAmount("(40.00)"), -4000);
    assert.equal(parseAppAmount(""), 0);
    assert.equal(parseAppAmount("1.234,56 €", ","), 123456);
  });

  test("three decimal places and words are refused, not rounded or guessed", () => {
    assert.equal(parseAppAmount("12.345"), null);
    assert.equal(parseAppAmount("twelve"), null);
    assert.equal(parseAppAmount("1 2a3"), null);
  });

  test("the decimal separator is the column's, not each cell's", () => {
    assert.equal(decimalSeparatorOf(["1.234,56 €", "0,00 €"]), ",");
    assert.equal(decimalSeparatorOf(["₹1,234.00", "₹0.00"]), ".");
    assert.equal(decimalSeparatorOf(["1,234"]), ".");
    const parse = parseBudgetApp(YNAB_DECIMAL_COMMA)!;
    assert.equal(parse.transactions[0]!.amount, -123456);
    assert.equal(parse.transactions[0]!.date, "2026-09-02");
  });
});

describe("IMPORT-1 · dates", () => {
  test("a day over 12 in the first place proves day first", () => {
    const parse = parseBudgetApp(YNAB_DAY_FIRST)!;
    assert.equal(parse.dateOrder, "dd-mm-yyyy");
    assert.deepEqual(parse.transactions.map((t) => t.date).slice(0, 2), ["2026-09-02", "2026-09-05"]);
  });

  test("a day over 12 in the second place proves month first", () => {
    const parse = parseBudgetApp(YNAB_MONTH_FIRST)!;
    assert.equal(parse.dateOrder, "mm-dd-yyyy");
    assert.deepEqual(parse.transactions.map((t) => t.date), ["2026-09-02", "2026-09-14", "2026-09-20"]);
  });

  test("when every row reads both ways, nothing is read until the person says which", () => {
    const unasked = parseBudgetApp(YNAB_AMBIGUOUS)!;
    assert.equal(unasked.needsDateOrder, true);
    assert.equal(unasked.transactions.length, 0);
    assert.deepEqual(unasked.accounts, ["ZZ Savings"]);

    const dayFirst = parseBudgetApp(YNAB_AMBIGUOUS, { dateOrder: "dd-mm-yyyy" })!;
    assert.deepEqual(dayFirst.transactions.map((t) => t.date), ["2026-04-03", "2026-06-05"]);
    const monthFirst = parseBudgetApp(YNAB_AMBIGUOUS, { dateOrder: "mm-dd-yyyy" })!;
    assert.deepEqual(monthFirst.transactions.map((t) => t.date), ["2026-03-04", "2026-05-06"]);
  });

  test("a file that proves both orders is refused, whatever the person said", () => {
    const parse = parseBudgetApp(YNAB_MIXED, { dateOrder: "dd-mm-yyyy" })!;
    assert.match(parse.dateProblem ?? "", /not clear which is which/);
    assert.equal(parse.transactions.length, 0);
    assert.equal(appDateOrder(["13/09/2026", "09/14/2026"]), "mixed");
  });

  test("ISO dates need no question", () => {
    assert.equal(appDateOrder(["2026-03-04", "2026-05-06"]), "yyyy-mm-dd");
    assert.equal(parseBudgetApp(ACTUAL_EXPORT)!.needsDateOrder, false);
  });
});

describe("IMPORT-1 · YNAB rows", () => {
  const parse = parseBudgetApp(YNAB_DAY_FIRST)!;

  test("the starting balance is left out and counted", () => {
    assert.equal(parse.startingBalances, 1);
    assert.ok(!parse.transactions.some((t) => t.payee === "Starting Balance"));
  });

  test("outflow is money out, inflow money in, and the raw cell is kept", () => {
    const shop = parse.transactions.find((t) => t.payee === "ZZ Kirana")!;
    assert.equal(shop.amount, -125050);
    assert.equal(shop.memo, "weekly shop");
    assert.deepEqual(shop.category, { group: "Everyday", name: "Groceries" });
    assert.equal(shop.raw.amount, "Outflow ₹1,250.50");
    assert.equal(shop.raw.date, "02/09/2026");
    const salary = parse.transactions.find((t) => t.payee === "ZZ Employer")!;
    assert.equal(salary.amount, 8_000_000);
    assert.equal(salary.category, null, "Ready to Assign is new money, not an envelope");
  });

  test("a 'Transfer : X' payee names the other source account", () => {
    const legs = parse.transactions.filter((t) => t.transferTo);
    assert.deepEqual(
      legs.map((t) => [t.account, t.transferTo, t.amount]),
      [["ZZ Savings", "ZZ Card", -500_000], ["ZZ Card", "ZZ Savings", 500_000]],
    );
  });

  test("Split (1/3)…(3/3) is one transaction of three lines", () => {
    const split = parse.transactions.find((t) => t.splits)!;
    assert.equal(split.amount, -100_000);
    assert.equal(split.account, "ZZ Card");
    assert.equal(split.payee, "ZZ Supermart");
    assert.deepEqual(split.splits!.map((l) => [l.category?.name, l.amount, l.memo]), [
      ["Groceries", -60_000, "veg"], ["Cleaning", -25_000, "soap"], ["Toys", -15_000, "kite"],
    ]);
    assert.equal(parse.transactions.length, 6);
  });

  test("a split with a part missing is an error on each line, not a short transaction", () => {
    const broken = parseBudgetApp(YNAB_DAY_FIRST.split("\n").filter((l) => !l.includes("Split (2/3)")).join("\n"))!;
    assert.ok(!broken.transactions.some((t) => t.splits));
    assert.ok(broken.errors.some((e) => /expected 3 parts/.test(e.reason)));
  });

  test("a split line that is a transfer comes out as a transfer of its own", () => {
    const parse2 = parseBudgetApp([
      YNAB_DAY_FIRST.split("\n")[0],
      '"ZZ Savings","","14/09/2026","ZZ Landlord","Home: Rent","Home","Rent","Split (1/2) rent","₹20,000.00","₹0.00","C"',
      '"ZZ Savings","","14/09/2026","Transfer : ZZ Card","","","","Split (2/2) card","₹3,000.00","₹0.00","C"',
      '"ZZ Card","","14/09/2026","Transfer : ZZ Savings","","","","","₹0.00","₹3,000.00","C"',
    ].join("\n"))!;
    const savings = parse2.transactions.filter((t) => t.account === "ZZ Savings");
    assert.deepEqual(savings.map((t) => [t.amount, t.transferTo, t.splits]), [
      [-2_000_000, null, null], [-300_000, "ZZ Card", null],
    ]);
    assert.equal(savings[0]!.payee, "ZZ Landlord");
  });
});

describe("IMPORT-1 · Actual Budget rows [unverified columns]", () => {
  const parse = parseBudgetApp(ACTUAL_EXPORT)!;

  test("a payee naming another account in the file, with no category, is a transfer", () => {
    assert.deepEqual(
      parse.transactions.filter((t) => t.transferTo).map((t) => [t.account, t.transferTo, t.amount]),
      [["ZZ Savings", "ZZ Card", -500_000], ["ZZ Card", "ZZ Savings", 500_000]],
    );
  });

  test("a parent row and its Split_Amount lines are one split", () => {
    const split = parse.transactions.find((t) => t.splits)!;
    assert.equal(split.amount, -85_000);
    assert.deepEqual(split.splits!.map((l) => [l.category?.name, l.amount]), [
      ["Groceries", -60_000], ["Cleaning", -25_000],
    ]);
  });

  test("lines that do not add up to their parent are refused", () => {
    const parse2 = parseBudgetApp(ACTUAL_EXPORT.replace("-850.00", "-900.00"))!;
    assert.ok(!parse2.transactions.some((t) => t.splits));
    assert.ok(parse2.errors.some((e) => /add up/.test(e.reason)));
  });

  test("the column names are found tolerantly: order, case and spelling", () => {
    const parse2 = parseBudgetApp([
      "date,amount,account name,payee name,category name,memo",
      "2026-09-02,-10.00,ZZ Savings,ZZ Kirana,Groceries,",
    ].join("\n"))!;
    assert.equal(parse2.app, "actual");
    assert.equal(parse2.transactions[0]!.amount, -1000);
    assert.equal(parse2.transactions[0]!.account, "ZZ Savings");
  });
});

describe("IMPORT-1 · categories to envelopes", () => {
  const envelopes: Envelope[] = [
    { id: "g", name: "Groceries", groupName: "Everyday" },
    { id: "i1", name: "Insurance", groupName: "Bills" },
    { id: "i2", name: "Insurance", groupName: "Car" },
    { id: "c", name: "Cleaning", groupName: "Household" },
  ];

  test("'Group: Category' first, then the category alone when only one envelope has it", () => {
    assert.equal(matchEnvelope({ group: "Car", name: "Insurance" }, envelopes), "i2");
    assert.equal(matchEnvelope({ group: "Home", name: "Cleaning" }, envelopes), "c");
    assert.equal(matchEnvelope({ group: "Pets", name: "Insurance" }, envelopes), null, "two Insurances: no guess");
    assert.equal(matchEnvelope({ group: "Fun", name: "Toys" }, envelopes), null);
  });

  test("the plan: transfers only between mapped accounts, splits keep unmatched lines empty", () => {
    const parse = parseBudgetApp(YNAB_DAY_FIRST)!;
    const both = planBudgetAppImport(parse, new Map([["ZZ Savings", "acc-s"], ["ZZ Card", "acc-c"]]), envelopes);
    assert.equal(both.transfers, 2);
    const card = both.byAccount.get("acc-c")!.records;
    assert.equal(card.find((r) => r.proposed?.transferAccountId)?.proposed?.transferAccountId, "acc-s");
    const split = card.find((r) => r.proposed?.splits)!;
    assert.deepEqual(split.proposed!.splits!.map((l) => l.categoryId), ["g", "c", null]);
    assert.equal(both.byAccount.get("acc-s")!.records.find((r) => r.narration === "ZZ Gym")!.proposed!.categoryId, null);

    const one = planBudgetAppImport(parse, new Map([["ZZ Savings", "acc-s"]]), envelopes);
    assert.equal(one.transfers, 0, "the card is not coming across, so its bill is an ordinary row");
    assert.equal(one.byAccount.size, 1);
    assert.ok(one.leftOut > 0);
  });
});
