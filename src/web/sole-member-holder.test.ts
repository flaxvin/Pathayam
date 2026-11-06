/**
 * UI-8 · In a one-member household the forms show no "Whose is it" picker, so
 * a policy, an asset or a loan was created with no holder. UI-3 counts an
 * unheld policy as the sole member's — but only while they are alone: once a
 * second member joined, an empty holder meant "the household's, jointly"
 * again, and the first member's 80D policy dropped off their tax page without
 * a word. The holder is now stored at creation.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";
import { queryOne } from "../db/db.ts";
import { rupees } from "../core/money.ts";
import { policyTaxSuggestion } from "../domain/insurance.ts";
import { createAccount } from "../domain/accounts.ts";

const RAVI = "m-ravi";
const PRIYA = "m-priya";

describe("UI-8 · the sole member is the holder of what they create", () => {
  test("a policy, an asset and a loan made alone keep counting once a second member joins", async () => {
    const db = freshDb();
    seedMember(db, RAVI, "Ravi");
    const bank = createAccount(db, { memberId: RAVI, source: "ui" }, {
      name: "Fictional Savings", kind: "budget", subtype: "savings", openingDate: "2026-01-01",
      openingBalance: rupees(1_00_000),
    }).id;
    const app = await startTestApp(db, { memberId: RAVI });
    try {
      assert.equal((await app.post("/insurance/new", {
        insurer: "Fictional Health", kind: "health", premium: "24,500", frequency: "yearly",
        next_due: "2026-11-20", tax_group: "80d-self",
      })).status, 303);
      assert.equal((await app.post("/portfolio/asset/new", {
        name: "Fictional Gold", subtype: "commodity", value: "50000",
      })).status, 303);
      assert.equal((await app.post("/loans/new", {
        lender: "Fictional Lender", loan_type: "personal", sanctioned: "100000", sanction_date: "2026-01-01",
        interest_model: "reducing", annual_rate: "12", tenure_months: "12", repayment_account_id: bank,
      })).status, 303);
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }

    const holder = (sql: string) => queryOne<{ h: string | null }>(db, sql)?.h;
    assert.equal(holder(`SELECT holder_member_id AS h FROM insurance_policies WHERE insurer = 'Fictional Health'`), RAVI);
    assert.equal(holder(`SELECT holder_member_id AS h FROM accounts WHERE name = 'Fictional Gold'`), RAVI);
    assert.equal(holder(
      `SELECT a.holder_member_id AS h FROM loans l JOIN accounts a ON a.id = l.account_id WHERE l.lender = 'Fictional Lender'`,
    ), RAVI);

    seedMember(db, PRIYA, "Priya");
    assert.equal(policyTaxSuggestion(db, RAVI, 2026).s80d, rupees(24_500), "still Ravi's with two members");
  });

  test("with two members an unnamed holder stays empty: the household's, jointly", async () => {
    const db = freshDb();
    seedMember(db, RAVI, "Ravi");
    seedMember(db, PRIYA, "Priya");
    const app = await startTestApp(db, { memberId: RAVI });
    try {
      assert.equal((await app.post("/insurance/new", {
        insurer: "Fictional Joint", kind: "home", premium: "5,000", frequency: "yearly",
        next_due: "2026-12-01", tax_group: "none", holder_member_id: "", visibility: "household",
      })).status, 303);
    } finally {
      await app.close();
    }
    assert.equal(
      queryOne<{ h: string | null }>(db, `SELECT holder_member_id AS h FROM insurance_policies WHERE insurer = 'Fictional Joint'`)?.h,
      null,
    );
  });
});
