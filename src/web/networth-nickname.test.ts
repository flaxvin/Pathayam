/**
 * D8e · Net worth calls an account what every other screen calls it.
 *
 * Accounts, Cards, the transfer form and the register all show an account by
 * the household's nickname when it has one ("Salary account"), and by the
 * bank's name otherwise. Net worth listed the bank's name ("HDFC Bank Savings
 * 50100…"), so the same account went by two names depending on the screen.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";
import { createAccount } from "../domain/accounts.ts";
import { createAssetAccount } from "../domain/assets.ts";
import { createTransfer } from "../domain/transactions.ts";
import { execute } from "../db/db.ts";
import { rupees, type Paise } from "../core/money.ts";

const actor = { memberId: "m-ravi", source: "ui" as const };

describe("D8e · net worth uses the nickname", () => {
  test("every kind of line shows nickname || name", async () => {
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    const salary = createAccount(db, actor, {
      name: "Bank Formal Savings", nickname: "Salary account", kind: "budget", subtype: "savings",
      openingDate: "2026-08-01", openingBalance: rupees(10_000),
    }).id;
    createAccount(db, actor, {
      name: "Bank Formal Card", nickname: "Daily card", kind: "credit", subtype: "credit-card",
      openingDate: "2026-08-01", openingBalance: -rupees(2_000),
    });
    const spare = createAccount(db, actor, {
      name: "Bank Formal Overpaid Card", nickname: "Spare card", kind: "credit", subtype: "credit-card",
      openingDate: "2026-08-01", openingBalance: 0,
    }).id;
    // Overpaid: a card in credit is listed with the cash.
    createTransfer(db, actor, { fromAccountId: salary, toAccountId: spare, amount: rupees(500) as Paise, date: "2026-08-02" });
    createAccount(db, actor, {
      name: "Bank Formal FD", nickname: "Rainy-day FD", kind: "tracking", subtype: "fixed-deposit",
      openingDate: "2026-08-01", openingBalance: rupees(50_000),
    });
    const flat = createAssetAccount(db, actor, {
      name: "Formal Property Deed", subtype: "physical", openingValue: rupees(1_000_000) as Paise, asOf: "2026-08-01",
    });
    execute(db, `UPDATE accounts SET nickname = 'The flat' WHERE id = ?`, typeof flat === "string" ? flat : flat.id);
    // An account with no nickname still goes by its name.
    createAccount(db, actor, {
      name: "Plain Wallet", kind: "budget", subtype: "cash", openingDate: "2026-08-01", openingBalance: rupees(300),
    });

    const app = await startTestApp(db, { memberId: "m-ravi" });
    try {
      const res = await app.get("/net-worth");
      assert.equal(res.status, 200);
      const page = await res.text();
      for (const nick of ["Salary account", "Daily card", "Spare card", "Rainy-day FD", "The flat", "Plain Wallet"]) {
        assert.ok(page.includes(nick), `net worth does not show "${nick}"`);
      }
      assert.doesNotMatch(page, /Bank Formal|Formal Property Deed/, "net worth shows the bank's name over the nickname");
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });
});
