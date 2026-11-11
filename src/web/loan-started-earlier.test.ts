/**
 * UI-12 · A loan added part-way through its life.
 *
 * A home loan sanctioned in April 2024 for 240 months, entered today with what
 * is owed now, showed "About 240 instalments left" and an EMI below the bank's:
 * the projection runs the whole tenure from today on today's balance. Nothing
 * on the form or the loan page said so. Found in the fresh-eyes browser pass
 * (row 7). The figures stay as they are; the pages say what they assume.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember } from "./harness.test-data.ts";
import { renderLoanDetail, renderNewLoanForm } from "./pages/loans.ts";
import { createLoan, projectLoan, type CreateLoanInput } from "../domain/loans.ts";
import { rupees } from "../core/money.ts";
import { todayIST, addDays, type IsoDate } from "../core/dates.ts";
import { shiftMonths } from "../loans/amortisation.ts";
import type { Actor } from "../core/events.ts";

const RAVI = "m-ravi";
const ravi: Actor = { memberId: RAVI, source: "ui" };
const flat = (s: unknown) => String(s).replace(/\s+/g, " ");

function loanPage(sanctionDate: IsoDate, extra: Partial<CreateLoanInput> = {}): string {
  const db = freshDb();
  seedMember(db, RAVI, "Ravi");
  const loan = createLoan(db, ravi, {
    lender: "Test Bank", loanType: "home", sanctioned: rupees(45_00_000), sanctionDate,
    interestModel: "reducing", annualRatePct: 8.5, tenureMonths: 240,
    currentOutstanding: rupees(42_10_000), ...extra,
  });
  return flat(renderLoanDetail({
    projection: projectLoan(db, loan.id)!, payments: [], disbursements: [], rates: [], budgetAccounts: [],
  }));
}

const NOTE = /assume its full 240-month tenure starts now/;

test("a loan sanctioned well before it was added says its figures assume the full tenure from now", () => {
  const page = loanPage("2024-04-15");
  assert.match(page, NOTE);
  assert.match(page, /sanctioned on 15-04-2024/);
});

test("a loan added within a month of its sanction says nothing of the kind", () => {
  assert.doesNotMatch(loanPage(todayIST()), NOTE);
  /*
   * ENG-20 · A month back from the 29th-31st can clamp to a shorter month's
   * last day: from 31 March that is 28 February, and 28 February plus a month
   * is 28 March, so the loan rightly reads as more than a month old and the test
   * failed. On such a day the boundary is not reachable; 28 days back stands in.
   */
  const today = todayIST();
  const monthAgo = shiftMonths(today, -1);
  const back = monthAgo.slice(8) === today.slice(8) ? monthAgo : addDays(today, -28);
  assert.doesNotMatch(loanPage(back as IsoDate), NOTE, "a month is not more than a month");
});

test("the form says, beside the part-way fields, what a loan that started earlier is worked out on", () => {
  const form = flat(renderNewLoanForm({ members: [], accounts: [] }));
  assert.match(form, /Started before today\?/);
  assert.match(form, /over the whole tenure, as if the loan began now/);
});

/*
 * The first instalment date dates the schedule's rows and History known from
 * labels the lifetime figures; neither shortens the tenure or moves the EMI, so
 * filling them in does not make the note untrue, and it stays.
 */
test("the note stays when the first instalment date or the history date is given", () => {
  assert.match(loanPage("2024-04-15", { firstInstalmentDate: "2024-05-05" }), NOTE);
  assert.match(loanPage("2024-04-15", { historyFrom: "2024-04-15" }), NOTE);
});
