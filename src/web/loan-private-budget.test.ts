/**
 * UI-14 · A private loan, through the screens, as the other member.
 *
 * [verified in browser, 13-11-2026] Meera's private car loan "Swift", repaid
 * from the shared SBI account: /loans hid it from Arjun, but its envelope with
 * the EMI target sat in the household budget, so "Swift" was on his budget, the
 * Move/Add/Transfer/Categories/Rules/Review/Insurance pickers, Query and Search,
 * Reports and Overview, Activity, Payees and the SBI register.
 *
 * Here Priya plays Meera and Ravi plays Arjun.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";
import type { Actor } from "../core/events.ts";
import { rupees, type Paise } from "../core/money.ts";
import { todayIST } from "../core/dates.ts";
import { createAccount } from "../domain/accounts.ts";
import { listLoans, paymentCategoryForLoan } from "../domain/loans.ts";
import { personalBudgetFor, householdBudgetId } from "../domain/budgets.ts";
import { setAssigned } from "../domain/budget.ts";
import { identityProblems } from "../engine/identity.test-data.ts";
import { monthOf } from "../core/dates.ts";

const RAVI = "m-ravi";
const PRIYA = "m-priya";
const priya: Actor = { memberId: PRIYA, source: "ui" };
const NAME = "Swiftcar";

function household() {
  const db = freshDb();
  seedMember(db, RAVI, "Ravi");
  seedMember(db, PRIYA, "Priya");
  const sbi = createAccount(db, priya, {
    name: "SBI Savings", kind: "budget", subtype: "savings",
    openingDate: "2026-01-01", openingBalance: rupees(3_00_000) as Paise,
  }).id;
  return { db, sbi };
}

const RAVI_PAGES = [
  "/", "/move", "/add", "/transfer", "/categories", "/rules", "/review", "/insurance",
  `/query?q=${NAME}`, `/search?q=${NAME}`, "/query", "/reports", "/overview", "/activity",
  "/payees", "/loans", "/net-worth",
];

describe("UI-14 · a private loan repaid from a shared account", () => {
  test("Ravi sees its envelope nowhere; Priya budgets and pays it in her own budget", async () => {
    const { db, sbi } = household();
    const asPriya = await startTestApp(db, { memberId: PRIYA });
    try {
      const made = await asPriya.post("/loans/new", {
        lender: "Fictional Auto Finance", nickname: NAME, loan_type: "car",
        sanctioned: "600000", sanction_date: todayIST(), annual_rate: "9", tenure_months: "60",
        current_outstanding: "600000", repayment_account_id: sbi,
        holder_member_id: PRIYA, visibility: "private",
      });
      assert.equal(made.status, 303, await made.text());
      const loan = listLoans(db)[0]!;
      const payment = paymentCategoryForLoan(db, loan.id)!;
      const own = personalBudgetFor(db, PRIYA);
      assert.ok(own, "Priya's own budget holds the loan's envelope");

      // Her own budget shows it, with its EMI target.
      const hers = await (await asPriya.get(`/?budget=${own.id}`)).text();
      assert.ok(hers.includes(NAME), "Priya's budget lists the loan envelope");

      // She funds it there and pays the instalment from the shared account.
      setAssigned(db, priya, monthOf(todayIST()), payment.id, rupees(12_455) as Paise);
      const paid = await asPriya.post(`/loans/${loan.id}/pay`, {
        date: todayIST(), amount: "12455", from_account_id: sbi,
      });
      assert.equal(paid.status, 303, await paid.text());
      assert.deepEqual(asPriya.failures, []);
    } finally {
      await asPriya.close();
    }

    const asRavi = await startTestApp(db, { memberId: RAVI });
    try {
      for (const path of [...RAVI_PAGES, `/accounts/${sbi}`, `/?budget=${householdBudgetId(db)}`]) {
        const res = await asRavi.get(path);
        const body = await res.text();
        assert.ok(res.status < 500, `${path} answered ${res.status}`);
        // Query and Search echo what was typed; that is Ravi's own text, not a leak.
        const shown = body.replaceAll(`q=${NAME}`, "").replaceAll(`value="${NAME}"`, "");
        assert.ok(!shown.includes(NAME), `${path} names Priya's private loan to Ravi`);
      }
      assert.deepEqual(asRavi.failures, []);
    } finally {
      await asRavi.close();
    }
    assert.deepEqual(identityProblems(db, monthOf(todayIST())), []);
  });

  test("switching an untouched loan to private on its page moves the envelope; one with payments is refused", async () => {
    const { db, sbi } = household();
    const app = await startTestApp(db, { memberId: PRIYA });
    try {
      for (const nickname of [`${NAME}A`, `${NAME}B`]) {
        const res = await app.post("/loans/new", {
          lender: "Fictional Auto Finance", nickname, loan_type: "car",
          sanctioned: "100000", sanction_date: todayIST(), annual_rate: "9", tenure_months: "12",
          current_outstanding: "100000", repayment_account_id: sbi,
          holder_member_id: PRIYA, visibility: "household",
        });
        assert.equal(res.status, 303, await res.text());
      }
      const [a, b] = listLoans(db);
      const pay = await app.post(`/loans/${b!.id}/pay`, {
        date: todayIST(), amount: "8745", from_account_id: sbi,
      });
      assert.equal(pay.status, 303, await pay.text());

      const ok = await app.post(`/loans/${a!.id}/holder`, { holder_member_id: PRIYA, visibility: "private" });
      assert.equal(ok.status, 303, await ok.text());
      const own = personalBudgetFor(db, PRIYA)!;
      const budgetOf = (loanId: string) => (db.prepare(
        `SELECT c.budget_id AS b FROM loans l JOIN categories c ON c.id = l.payment_category_id WHERE l.id = ?`,
      ).get(loanId) as { b: string }).b;
      assert.equal(budgetOf(a!.id), own.id);

      const refused = await app.post(`/loans/${b!.id}/holder`, { holder_member_id: PRIYA, visibility: "private" });
      assert.equal(refused.status, 422);
      assert.match(await refused.text(), /already holds money or payments/);
      assert.equal(budgetOf(b!.id), householdBudgetId(db));
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });
});
