/**
 * D7 · updateTransaction accepted a new amount on a split transaction without
 * its lines.
 *
 * A ₹3.36 card charge split ₹1.12 (A) / ₹2.24 (B), edited to an amount of
 * 3 paise with no lines: the lines still totalled ₹3.36, the payment envelope
 * counted ₹3.33 more filed spending than the card was charged, and the identity
 * was out by +₹3.33 from 2026-01. On a bank account the same ₹3.33 turned up in
 * Ready to Assign from nowhere. The HTTP edit form refused it; the domain did
 * not, so any other caller could.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Actor } from "../core/events.ts";
import { Refusal } from "../core/refusal.ts";
import { createAccount } from "./accounts.ts";
import { createTransaction, updateTransaction, getSplits } from "./transactions.ts";
import { createGroup, createCategory } from "./budget.ts";
import { freshHousehold, identityProblems, RAVI } from "../engine/identity.test-data.ts";

const actor: Actor = { memberId: RAVI, source: "ui" };

function splitCharge(kind: "credit" | "budget") {
  const db = freshHousehold();
  const group = createGroup(db, actor, "G").id;
  const a = createCategory(db, actor, { groupId: group, name: "A" }).id;
  const b = createCategory(db, actor, { groupId: group, name: "B" }).id;
  const account = createAccount(db, actor, {
    name: kind === "credit" ? "Card" : "Bank", kind,
    subtype: kind === "credit" ? "credit-card" : "savings", openingDate: "2025-01-01",
    openingBalance: kind === "budget" ? 1_000_000 : 0,
  }).id;
  const tx = createTransaction(db, actor, {
    accountId: account, amount: -336, date: "2026-01-15",
    splits: [{ categoryId: a, amount: -112 }, { categoryId: b, amount: -224 }],
  });
  return { db, tx, a, b };
}

describe("D7 · a split transaction's amount moves with its lines", () => {
  for (const kind of ["credit", "budget"] as const) {
    test(`an amount-only edit is refused (${kind === "credit" ? "card" : "bank"})`, () => {
      const s = splitCharge(kind);
      assert.throws(
        () => updateTransaction(s.db, actor, s.tx.id, { amount: -3 }),
        (e: unknown) => e instanceof Refusal && /its lines/.test((e as Error).message),
      );
      assert.deepEqual(identityProblems(s.db, "2027-03"), []);
    });
  }

  test("with lines that add up, it goes through", () => {
    const s = splitCharge("credit");
    updateTransaction(s.db, actor, s.tx.id, {
      amount: -300, splits: [{ categoryId: s.a, amount: -100 }, { categoryId: s.b, amount: -200 }],
    });
    assert.equal(getSplits(s.db, s.tx.id).reduce((n, l) => n + l.amount, 0), -300);
    assert.deepEqual(identityProblems(s.db, "2027-03"), []);
  });

  test("filing it whole to one envelope with a new amount goes through", () => {
    const s = splitCharge("credit");
    updateTransaction(s.db, actor, s.tx.id, { amount: -300, categoryId: s.a });
    assert.deepEqual(identityProblems(s.db, "2027-03"), []);
  });

  test("the same amount with no lines is not an amount change", () => {
    const s = splitCharge("credit");
    updateTransaction(s.db, actor, s.tx.id, { amount: -336, memo: "Receipt" });
    assert.deepEqual(identityProblems(s.db, "2027-03"), []);
  });
});
