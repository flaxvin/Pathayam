/**
 * ENG-6 · A refunded purchase is not spending.
 *
 * envelopeSpendBetween and the insights counted money leaving an envelope and
 * ignored money coming back. A ₹50,000 laptop bought and refunded inside the
 * window added ₹50,000 to FIRE's annual expenses — about ₹14L on the FIRE
 * number at 3.5% — lowered the buffer and raised an insight. Spending now nets
 * per envelope per window, floored at 0, so a refund larger than the window's
 * purchases in that envelope never lowers another envelope's figure.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import { createAccount } from "../domain/accounts.ts";
import { createGroup, createCategory } from "../domain/budget.ts";
import { createTransaction } from "../domain/transactions.ts";
import { spendingInsights } from "../domain/insights.ts";
import { envelopeSpendBetween } from "./repository.ts";

const actor: Actor = { memberId: "m", source: "ui" };

function setup() {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    "m", "ravi@example.com", "Ravi", nowIST());
  const bank = createAccount(db, actor, {
    name: "Bank", kind: "budget", subtype: "savings",
    openingDate: "2026-01-01", openingBalance: rupees(10_00_000),
  }).id;
  const group = createGroup(db, actor, "Everyday");
  const food = createCategory(db, actor, { groupId: group.id, name: "Food" }).id;
  const gadgets = createCategory(db, actor, { groupId: group.id, name: "Gadgets" }).id;
  const tx = (categoryId: string, amount: number, date: string) =>
    createTransaction(db, actor, { accountId: bank, amount: rupees(amount), categoryId, date, payeeName: "x" });
  return { db, food, gadgets, tx };
}

test("a purchase refunded in the window nets to nothing", () => {
  const { db, food, gadgets, tx } = setup();
  tx(food, -3_000, "2026-08-05");
  tx(gadgets, -50_000, "2026-08-10");
  tx(gadgets, 50_000, "2026-08-20");
  assert.equal(envelopeSpendBetween(db, "2026-08-01", "2026-08-31"), rupees(3_000));
  db.close();
});

test("a refund bigger than the window's purchases in its envelope floors at 0", () => {
  const { db, food, gadgets, tx } = setup();
  tx(gadgets, -50_000, "2026-07-25"); // bought before the window
  tx(gadgets, 50_000, "2026-08-02");  // refunded inside it
  tx(food, -3_000, "2026-08-05");
  assert.equal(envelopeSpendBetween(db, "2026-08-01", "2026-08-31"), rupees(3_000),
    "the refund does not eat Food's spending");
  db.close();
});

test("a refunded purchase raises no insight", () => {
  const { db, gadgets, tx } = setup();
  for (const m of ["05", "06", "07"]) tx(gadgets, -2_000, `2026-${m}-10`);
  tx(gadgets, -2_000, "2026-08-03");
  tx(gadgets, -50_000, "2026-08-05");
  tx(gadgets, 50_000, "2026-08-12");
  assert.equal(spendingInsights(db, "2026-08-15").some((i) => i.categoryName === "Gadgets"), false);
  db.close();
});
