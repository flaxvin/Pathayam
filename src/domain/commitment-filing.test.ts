/**
 * D8 · Spending filed straight to a commitment envelope.
 *
 * A commitment envelope's balance is the claim between two budgets
 * (dueFromOtherBudgets reads it), while the receiving budget's means count only
 * what was *assigned* to it. ₹224 from Ravi's bank filed to his envelope for the
 * household lowered the claim by ₹224 with no expense in the household to meet
 * it: the household's identity was out by −₹224 in every month from 2025-07, live
 * and through the rollup. The Add form offered the envelope, and a split line, a
 * recategorise and an edited split line all got the same result.
 *
 * Every filing path now refuses one, and no filing picker offers it.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execute } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST } from "../core/dates.ts";
import { Refusal } from "../core/refusal.ts";
import { createAccount } from "./accounts.ts";
import { createTransaction, updateTransaction } from "./transactions.ts";
import { ensurePersonalBudget } from "./budgets.ts";
import { createGroup, createCategory, startPersonalBudget } from "./budget.ts";
import { ensureCommitmentEnvelope } from "./commitments.ts";
import { freshHousehold, identityProblems, RAVI } from "../engine/identity.test-data.ts";
import { startTestApp } from "../web/harness.test-data.ts";

const actor: Actor = { memberId: RAVI, source: "ui" };
const HH = "budget-household";

function setup() {
  const db = freshHousehold();
  const ravi = ensurePersonalBudget(db, RAVI, "Ravi").id;
  startPersonalBudget(db, actor, ravi);
  const envelope = ensureCommitmentEnvelope(db, actor, ravi, HH).id;
  const own = createCategory(db, actor, {
    groupId: createGroup(db, actor, "Ravi's things", "normal", ravi).id, name: "Books",
  }).id;
  const bank = createAccount(db, actor, {
    name: "RBank", kind: "budget", subtype: "savings", openingDate: "2025-01-01",
    openingBalance: 5_000_000, budgetId: ravi, holderMemberId: RAVI,
  }).id;
  return { db, ravi, envelope, own, bank };
}

const refused = (e: unknown) =>
  e instanceof Refusal && /set aside for another/.test((e as Error).message);

describe("D8 · nothing is filed to a commitment envelope", () => {
  test("a plain transaction is refused, and the identity holds", () => {
    const s = setup();
    assert.throws(() => createTransaction(s.db, actor, {
      accountId: s.bank, amount: -22_400, date: "2025-07-18", categoryId: s.envelope,
    }), refused);
    assert.deepEqual(identityProblems(s.db, "2027-03"), []);
  });

  test("a split line is refused", () => {
    const s = setup();
    assert.throws(() => createTransaction(s.db, actor, {
      accountId: s.bank, amount: -22_400, date: "2025-07-18",
      splits: [{ categoryId: s.own, amount: -12_400 }, { categoryId: s.envelope, amount: -10_000 }],
    }), refused);
  });

  test("recategorising, or editing the lines, is refused", () => {
    const s = setup();
    const tx = createTransaction(s.db, actor, {
      accountId: s.bank, amount: -22_400, date: "2025-07-18", categoryId: s.own,
    });
    assert.throws(() => updateTransaction(s.db, actor, tx.id, { categoryId: s.envelope }), refused);
    assert.throws(() => updateTransaction(s.db, actor, tx.id, {
      splits: [{ categoryId: s.own, amount: -12_400 }, { categoryId: s.envelope, amount: -10_000 }],
    }), refused);
    assert.deepEqual(identityProblems(s.db, "2027-03"), []);
  });

  test("the Add form does not offer it, and posting it anyway is a 422", async () => {
    const s = setup();
    execute(s.db, `UPDATE household SET setup_completed_at = ? WHERE id = 1`, nowIST());
    const app = await startTestApp(s.db, { memberId: RAVI });
    try {
      const page = await (await app.get(`/add?account=${s.bank}`)).text();
      assert.ok(page.includes(s.own), "Ravi's own envelope is offered");
      assert.ok(!page.includes(`value="${s.envelope}"`), "the commitment envelope is not");
      const res = await app.post("/add", {
        account_id: s.bank, amount: "224", direction: "out", date: "2025-07-18",
        category_id: s.envelope, payee: "Shop",
      });
      assert.equal(res.status, 422);
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
    assert.deepEqual(identityProblems(s.db, "2027-03"), []);
  });
});
