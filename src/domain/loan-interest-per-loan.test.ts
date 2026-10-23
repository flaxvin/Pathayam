/**
 * DEBUG-ENGINE-8 · Interest per financial year is reported per loan, not per lender.
 *
 * The report grouped rows by the lender's name, so a home loan and a car loan
 * from the same bank came out as one line: the figure a household carries to a
 * §24(b) claim for the home loan included the car loan's interest too.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, queryAll } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST, type IsoDate } from "../core/dates.ts";
import { rupees, type Paise } from "../core/money.ts";
import { createAccount } from "./accounts.ts";
import { createLoan } from "./loans.ts";
import { loanInterestByFinancialYear } from "./reports.ts";

const actor: Actor = { memberId: "m", source: "ui" };

test("two loans from one lender are two lines", () => {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    "m", "ravi@example.com", "Ravi", nowIST());
  const bank = createAccount(db, actor, {
    name: "Bank", kind: "budget", subtype: "savings",
    openingDate: "2026-04-01", openingBalance: rupees(500_000),
  }).id;
  const home = createLoan(db, actor, {
    lender: "HDFC", loanType: "home",
    sanctioned: rupees(3_000_000) as Paise, sanctionDate: "2026-04-01" as IsoDate,
    interestModel: "reducing", annualRatePct: 8.5, tenureMonths: 240,
    firstInstalmentDate: "2026-05-05" as IsoDate, repaymentAccountId: bank,
  });
  const car = createLoan(db, actor, {
    lender: "HDFC", loanType: "car",
    sanctioned: rupees(800_000) as Paise, sanctionDate: "2026-04-01" as IsoDate,
    interestModel: "reducing", annualRatePct: 9.5, tenureMonths: 60,
    firstInstalmentDate: "2026-05-05" as IsoDate, repaymentAccountId: bank,
  });
  // One paid instalment on each, written directly: the report reads loan_payments.
  for (const [loan, interest] of [[home.id, rupees(21_000)], [car.id, rupees(6_300)]] as const) {
    execute(db,
      `INSERT INTO loan_payments (id, loan_id, date, amount, principal, interest, estimated, kind, created_at)
       VALUES (?, ?, '2026-05-05', ?, ?, ?, 0, 'instalment', ?)`,
      `p-${loan}`, loan, interest + rupees(5_000), rupees(5_000), interest, nowIST());
  }

  const rows = loanInterestByFinancialYear(db).filter((r) => r.fy === 2026);
  assert.equal(rows.length, 2, "one line for each loan");
  assert.deepEqual(rows.map((r) => r.interest).sort((a, b) => a - b), [rupees(6_300), rupees(21_000)]);
  void queryAll;
  db.close();
});
