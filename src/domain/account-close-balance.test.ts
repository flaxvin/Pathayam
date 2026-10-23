/**
 * An account still holding money, or still owing it, does not close quietly.
 *
 * Net worth counts open accounts only, so closing one takes its balance off
 * the statement — while the budget, which counts every account, keeps it.
 * With ₹50,000 in the bank and ₹20,000 owed on the card, net worth was
 * 50,000 − 20,000 = ₹30,000; closing both made it ₹0, and Ready to Assign
 * still read ₹50,000. The docs promise a warning; there was none, and the
 * family-loan close (WEALTH-30) already refuses the same thing for the same
 * reason — which the generic close bypassed on a family loan's own account.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, queryOne } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST } from "../core/dates.ts";
import { rupees, type Paise } from "../core/money.ts";
import { Refusal } from "../core/refusal.ts";
import { createAccount, closeAccount } from "./accounts.ts";
import { createTransaction } from "./transactions.ts";
import { createFamilyLoan, recordAdvance } from "./family-loans.ts";
import { netWorthStatement } from "./networth.ts";

const actor: Actor = { memberId: "m", source: "ui" };

function setup() {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    "m", "ravi@example.com", "Ravi", nowIST());
  const bank = createAccount(db, actor, {
    name: "Bank", kind: "budget", subtype: "savings",
    openingDate: "2025-01-01", openingBalance: rupees(50_000),
  }).id;
  const card = createAccount(db, actor, {
    name: "Card", kind: "credit", subtype: "credit-card",
    openingDate: "2025-01-01", openingBalance: -rupees(20_000) as Paise,
  }).id;
  return { db, bank, card };
}

const closedAt = (db: ReturnType<typeof setup>["db"], id: string) =>
  queryOne<{ closed_at: string | null }>(db, `SELECT closed_at FROM accounts WHERE id = ?`, id)!.closed_at;

describe("closing an account with a balance", () => {
  test("₹50,000 in the bank: refused, naming the balance, and net worth keeps it", () => {
    const { db, bank } = setup();
    assert.equal(netWorthStatement(db).netWorth, rupees(30_000));
    assert.throws(() => closeAccount(db, actor, bank), (e: unknown) =>
      e instanceof Refusal && /₹50,000/.test(e.message));
    assert.equal(closedAt(db, bank), null);
    assert.equal(netWorthStatement(db).netWorth, rupees(30_000));
  });

  test("₹20,000 owed on the card: refused", () => {
    const { db, card } = setup();
    assert.throws(() => closeAccount(db, actor, card), Refusal);
    assert.equal(closedAt(db, card), null);
  });

  test("a family loan's account, with the cousin still owing: refused here too", () => {
    const { db, bank } = setup();
    const loan = createFamilyLoan(db, actor, { counterparty: "Cousin", startedAt: "2025-01-01" });
    recordAdvance(db, actor, { loanId: loan.id, amount: rupees(10_000) as Paise, fromAccountId: bank, date: "2025-02-01" });
    assert.throws(() => closeAccount(db, actor, loan.account_id), Refusal);
  });

  test("at nil it closes", () => {
    const { db, bank } = setup();
    createTransaction(db, actor, {
      accountId: bank, amount: -rupees(50_000) as Paise, date: "2025-02-01", categoryId: null, memo: "emptied",
    });
    closeAccount(db, actor, bank);
    assert.notEqual(closedAt(db, bank), null);
  });
});
