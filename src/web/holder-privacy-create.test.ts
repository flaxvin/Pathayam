/**
 * WEB-4 · WEB-1's rule, at creation.
 *
 * The edit forms (WEB-1, FRESH-WEB-2) let a record be private only to the
 * member making it so. The four create forms that share renderHolderFields —
 * a loan, a family loan, a policy and a hand-valued asset — still took
 * "Whose is it: Ravi" + "Private to whoever holds it" from Priya: she hid a
 * record from herself and planted it, private, on Ravi. The form now says
 * "Private to me", and the routes hold to it.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";
import type { Actor } from "../core/events.ts";
import { rupees, type Paise } from "../core/money.ts";
import { createAccount } from "../domain/accounts.ts";
import { renderHolderFields } from "./pages/portfolio.ts";

const RAVI = "m-ravi";
const PRIYA = "m-priya";
const ravi: Actor = { memberId: RAVI, source: "ui" };

function household() {
  const db = freshDb();
  seedMember(db, RAVI, "Ravi");
  seedMember(db, PRIYA, "Priya");
  const bank = createAccount(db, ravi, {
    name: "Joint Bank", kind: "budget", subtype: "savings",
    openingDate: "2025-01-01", openingBalance: rupees(5_00_000) as Paise,
  }).id;
  return { db, bank };
}

const forms: { path: string; table: string; body: (bank: string) => Record<string, string> }[] = [
  {
    path: "/loans/new", table: "loans",
    body: (bank) => ({
      lender: "Fictional Lender", loan_type: "personal", sanctioned: "100000",
      sanction_date: "2026-01-01", interest_model: "reducing", annual_rate: "12",
      tenure_months: "12", repayment_account_id: bank,
    }),
  },
  { path: "/family/new", table: "family_loans", body: () => ({ counterparty: "Fictional Cousin" }) },
  {
    path: "/insurance/new", table: "insurance_policies",
    body: () => ({
      insurer: "Fictional Health", kind: "health", premium: "24000",
      frequency: "yearly", tax_group: "none",
    }),
  },
  {
    path: "/portfolio/asset/new", table: "accounts",
    body: () => ({ name: "Gold coins", subtype: "commodity", value: "50000" }),
  },
];

describe("WEB-4 · a new record is private only to whoever makes it", () => {
  for (const form of forms) {
    test(`${form.path} refuses private to somebody else, and allows private to me`, async () => {
      const { db, bank } = household();
      const app = await startTestApp(db, { memberId: PRIYA });
      const count = () =>
        (db.prepare(`SELECT COUNT(*) AS n FROM ${form.table}`).get() as { n: number }).n;
      try {
        const before = count();
        const res = await app.post(form.path, {
          ...form.body(bank), holder_member_id: RAVI, visibility: "private",
        });
        assert.equal(res.status, 422, await res.text());
        assert.equal(count(), before, "the record was saved anyway");

        const mine = await app.post(form.path, {
          ...form.body(bank), holder_member_id: PRIYA, visibility: "private",
        });
        assert.equal(mine.status, 303, await mine.text());
        const shared = await app.post(form.path, {
          ...form.body(bank), holder_member_id: RAVI, visibility: "household",
        });
        assert.equal(shared.status, 303, await shared.text());
        assert.deepEqual(app.failures, []);
      } finally {
        await app.close();
      }
    });
  }

  test("the shared holder fields say 'Private to me', as the account forms do", () => {
    const out = String(renderHolderFields([
      { id: RAVI, name: "Ravi" }, { id: PRIYA, name: "Priya" },
    ]));
    assert.match(out, />\s*Private to me\s*</);
    assert.doesNotMatch(out, /Private to whoever/);
    assert.doesNotMatch(out, /only the\s+holder sees it/);
  });
});
