/**
 * UI-PASS · What a second browser sweep, driving every form, turned up.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { CLIENT_SCRIPT } from "./client.ts";
import { STYLESHEET } from "./styles.ts";
import { execute } from "../db/db.ts";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";
import { createAccount } from "../domain/accounts.ts";
import { createLoan } from "../domain/loans.ts";
import { createFamilyLoan, closeFamilyLoan } from "../domain/family-loans.ts";
import { rupees, type Paise } from "../core/money.ts";
import type { Actor } from "../core/events.ts";

describe("UI-PASS-13 · a closed loan or arrangement offers nothing it would refuse", () => {
  const ravi: Actor = { memberId: "m-ravi", source: "ui" };

  test("a closed loan has no instalment, rate, prepay or disbursement controls", async () => {
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    const bank = createAccount(db, ravi, {
      name: "Household Bank", kind: "budget", subtype: "savings",
      openingDate: "2025-01-01", openingBalance: rupees(10_00_000) as Paise,
    }).id;
    const loan = createLoan(db, ravi, {
      lender: "Fictional Bank", loanType: "home", sanctioned: rupees(20_00_000) as Paise,
      disbursed: rupees(5_00_000) as Paise,
      sanctionDate: "2025-01-01", interestModel: "reducing", annualRatePct: 9, tenureMonths: 240,
      currentOutstanding: rupees(5_00_000) as Paise, repaymentAccountId: bank,
    });
    const app = await startTestApp(db, { memberId: "m-ravi" });
    try {
      const open = await (await app.get(`/loans/${loan.id}`)).text();
      assert.match(open, new RegExp(`href="/loans/${loan.id}/pay"`), "the control: an open loan offers them");

      execute(db, `UPDATE loans SET closed_at = '2026-01-01T00:00:00+05:30' WHERE id = ?`, loan.id);
      for (const path of [`/loans/${loan.id}`, "/loans"]) {
        const body = await (await app.get(path)).text();
        for (const action of ["pay", "rate", "prepay"]) {
          assert.doesNotMatch(body, new RegExp(`href="/loans/${loan.id}/${action}"`), `${path} offers ${action}`);
        }
        assert.doesNotMatch(body, new RegExp(`action="/loans/${loan.id}/disburse"`), `${path} offers a draw`);
      }
    } finally { await app.close(); }
  });

  test("a closed family arrangement says so instead of offering advance and repayment", async () => {
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    createAccount(db, ravi, {
      name: "Household Bank", kind: "budget", subtype: "savings",
      openingDate: "2025-01-01", openingBalance: rupees(10_000) as Paise,
    });
    const loan = createFamilyLoan(db, ravi, { counterparty: "Ammu" });
    closeFamilyLoan(db, ravi, loan.id);
    const app = await startTestApp(db, { memberId: "m-ravi" });
    try {
      const body = await (await app.get(`/family/${loan.id}`)).text();
      assert.doesNotMatch(body, /\/advance"/);
      assert.doesNotMatch(body, /\/repayment"/);
      assert.match(body, /This arrangement is closed/);
    } finally { await app.close(); }
  });
});

describe("UI-PASS-6 · one long name does not push the page sideways", () => {
  test("the desktop column may be narrower than its widest table", () => {
    // `1fr` is `minmax(auto, 1fr)`: the column grew to the min-content of a
    // table that should have scrolled inside its own container.
    assert.match(STYLESHEET, /\.with-sidebar \{[^}]*grid-template-columns: 220px minmax\(0, 1fr\)/);
  });
  test("text wraps when nothing else fits, and a select is no wider than its box", () => {
    assert.match(STYLESHEET, /main \{ overflow-wrap: break-word; \}/);
    assert.match(STYLESHEET, /select \{ min-width: 0; max-width: 100%;/);
  });
});

describe("UI-PASS-1 · a destructive form asks first, under the CSP", () => {
  test("no template carries an inline event handler the CSP would refuse", () => {
    const dir = new URL("./pages/", import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    for (const name of ["../../app.ts", "../layout.ts"]) files.push(name);
    for (const file of files) {
      const source = readFileSync(new URL(file, dir), "utf8");
      assert.doesNotMatch(source, /\son(submit|click|change|input)="/, `${file} has an inline handler`);
    }
  });

  test("the client asks the form's data-confirm question before it posts", () => {
    assert.match(CLIENT_SCRIPT, /form\.dataset\.confirm && !window\.confirm\(form\.dataset\.confirm\)/);
    const manage = readFileSync(new URL("./pages/manage.ts", import.meta.url), "utf8");
    assert.match(manage, /action="\/categories\/\$\{c\.id\}\/delete"\s+data-confirm="/);
  });
});
