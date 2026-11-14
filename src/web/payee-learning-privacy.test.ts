/**
 * WEB-1 / WEB-2 · A payee seen only where another member cannot look stays out
 * of their screens: the rule a rename proposes, and the payee list itself.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";
import { queryAll } from "../db/db.ts";
import { createAccount } from "../domain/accounts.ts";
import { createGroup, createCategory } from "../domain/budget.ts";
import { createTransaction, listPayees } from "../domain/transactions.ts";
import { ensurePersonalBudget } from "../domain/budgets.ts";

const RAVI = "m-ravi";
const PRIYA = "m-priya";
const ravi = { memberId: RAVI, source: "ui" as const };

function world() {
  const db = freshDb();
  seedMember(db, RAVI, "Ravi");
  seedMember(db, PRIYA, "Priya");
  const his = ensurePersonalBudget(db, RAVI, "Ravi");
  const priv = createAccount(db, ravi, {
    name: "Ravi private", kind: "budget", subtype: "savings", openingDate: "2026-01-01",
    openingBalance: 1_000_000, holderMemberId: RAVI, visibility: "private", budgetId: his.id,
  });
  const joint = createAccount(db, ravi, {
    name: "Joint", kind: "budget", subtype: "savings", openingDate: "2026-01-01", openingBalance: 1_000_000,
  });
  // A household-visible account in his own budget, filed to his own envelope.
  const shown = createAccount(db, ravi, {
    name: "Ravi shown", kind: "budget", subtype: "savings", openingDate: "2026-01-01",
    openingBalance: 1_000_000, holderMemberId: RAVI, budgetId: his.id,
  });
  const group = createGroup(db, ravi, "Mine", "normal", his.id);
  const envelope = createCategory(db, ravi, { groupId: group.id, name: "Own envelope" });
  const privateTx = createTransaction(db, ravi, {
    accountId: priv.id, amount: -50_000, date: "2026-09-01", payeeName: "UPI-DRSHARMAPSYCH",
    raw: { narration: "UPI/DRSHARMAPSYCH/123456" },
  });
  const jointTx = createTransaction(db, ravi, {
    accountId: joint.id, amount: -20_000, date: "2026-09-02", payeeName: "UPI-DMART",
    raw: { narration: "UPI/DMARTREADY/998877" },
  });
  createTransaction(db, ravi, {
    accountId: shown.id, amount: -30_000, date: "2026-09-03", payeeName: "Secretpayee Kappa",
    categoryId: envelope.id,
  });
  return { db, privateTx: privateTx.id, jointTx: jointTx.id };
}

describe("WEB-1 · renaming a payee on a private account proposes no household rule", () => {
  test("Priya's /rules, /review and /activity never name it", async () => {
    const { db, privateTx, jointTx } = world();
    const asRavi = await startTestApp(db, { memberId: RAVI });
    const asPriya = await startTestApp(db, { memberId: PRIYA });
    try {
      const r = await asRavi.post(`/transaction/${privateTx}`, { payee: "Dr Sharma Psychiatry Secret" });
      assert.equal(r.status, 303);
      for (const path of ["/rules", "/review", "/activity"]) {
        const html = await (await asPriya.get(path)).text();
        assert.doesNotMatch(html, /Dr Sharma Psychiatry Secret/, path);
        // The rule's own words name the bank string too, and (Decision 6) the
        // old payee, used nowhere now, is gone rather than "Added" in /activity.
        assert.doesNotMatch(html, /DRSHARMA/, path);
      }
      // A rename on a row everyone can see still teaches a rule.
      await asRavi.post(`/transaction/${jointTx}`, { payee: "DMart" });
      const rules = queryAll<{ name: string }>(db, `SELECT name FROM rules WHERE proposed = 1`);
      assert.deepEqual(rules.map((x) => x.name.endsWith("→ DMart")), [true]);
      assert.deepEqual([...asRavi.failures, ...asPriya.failures], []);
    } finally { await asRavi.close(); await asPriya.close(); }
  });
});

describe("WEB-2 · a payee filed only to a member's own envelope is his", () => {
  test("listPayees and Priya's screens leave it out; Ravi still has it", async () => {
    const { db } = world();
    assert.ok(!listPayees(db, PRIYA).some((p) => p.name === "Secretpayee Kappa"));
    assert.ok(listPayees(db, RAVI).some((p) => p.name === "Secretpayee Kappa"));
    assert.ok(listPayees(db, PRIYA).some((p) => p.name === "UPI-DMART"));
    const asPriya = await startTestApp(db, { memberId: PRIYA });
    try {
      for (const path of ["/payees", "/add", "/activity", "/export.json"]) {
        const text = await (await asPriya.get(path)).text();
        assert.doesNotMatch(text, /Secretpayee Kappa/, path);
      }
      assert.deepEqual(asPriya.failures, []);
    } finally { await asPriya.close(); }
  });
});
