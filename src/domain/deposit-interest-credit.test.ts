/**
 * ENG-9 · A PPF or EPF's interest is counted once.
 *
 * The terms compute each year's interest and credit it on 31 March. A register
 * that also holds that credit as a line — an imported passbook, or somebody
 * entering the 31 March "Interest" row by hand — was read as a contribution on
 * top, so the year's interest was counted twice (and then earned interest
 * itself). For these two kinds a money-in line whose memo or payee says
 * "interest" is the credit the arithmetic already makes, and is left out.
 *
 *   ₹1,50,000 at 7.1% from 1 April 2025: 10,650 credited on 31 March 2026,
 *   so ₹1,60,650 on that day — with or without a recorded "Interest" line.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Actor } from "../core/events.ts";
import { rupees } from "../core/money.ts";
import { freshHousehold, RAVI } from "../engine/identity.test-data.ts";
import { createAccount } from "./accounts.ts";
import { createTransaction } from "./transactions.ts";
import { setDepositTerms, computedDepositValue } from "./deposits.ts";

const ravi: Actor = { memberId: RAVI, source: "ui" };

function ppf(kind: "ppf" | "epf" | "other" = "ppf") {
  const db = freshHousehold();
  const id = createAccount(db, ravi, {
    name: "Fictional PPF", kind: "tracking", subtype: "asset", openingDate: "2025-04-01",
  }).id;
  setDepositTerms(db, ravi, id, {
    kind, principal: rupees(1_50_000), rateBp: 710, startDate: "2025-04-01",
    ...(kind === "other" ? { compounding: "yearly" } : {}),
  }, "2025-04-01");
  return { db, id };
}

describe("ENG-9 · a recorded interest credit is not a contribution", () => {
  test("a 31 March line memo'd Interest leaves the value as computed", () => {
    const { db, id } = ppf();
    createTransaction(db, ravi, { accountId: id, amount: rupees(10_650), date: "2026-03-31", memo: "Interest for 2025-26" });
    assert.equal(computedDepositValue(db, id, "2026-03-31")!.value, rupees(1_60_650));
  });

  test("so does one whose payee is the interest credit", () => {
    const { db, id } = ppf("epf");
    createTransaction(db, ravi, { accountId: id, amount: rupees(9_762.5), date: "2026-03-31", payeeName: "PPF interest credit" });
    // EPF earns on the balance each month opened with, so April 2025 (opened at 0)
    // earns nothing: 1,50,000 × 7.1% × 11/12 = 9,762.50.
    assert.equal(computedDepositValue(db, id, "2026-03-31")!.value, 1_59_76_250);
  });

  test("an ordinary contribution still counts", () => {
    const { db, id } = ppf();
    createTransaction(db, ravi, { accountId: id, amount: rupees(10_000), date: "2025-06-03", memo: "Deposit" });
    assert.equal(computedDepositValue(db, id, "2026-03-31")!.value, rupees(1_60_000) + 11_24_167);
  });

  test("an 'other' deposit reads its register as it did", () => {
    const { db, id } = ppf("other");
    const before = computedDepositValue(db, id, "2026-03-31")!.value;
    createTransaction(db, ravi, { accountId: id, amount: rupees(1_000), date: "2026-03-31", memo: "Interest" });
    assert.equal(computedDepositValue(db, id, "2026-03-31")!.value, before + rupees(1_000));
  });
});
