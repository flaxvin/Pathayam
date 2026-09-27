/**
 * EXTRA-4 · A charge converted to EMI cannot be deleted out from under its plan.
 *
 * Deleting the ₹60,000 purchase took it off the card and left the plan and
 * the ₹60,000 credit the conversion put on the card for it: the card in
 * credit for money never spent, and six instalments for a purchase the ledger
 * no longer had. Undoing the charge's create failed on the plan's foreign key
 * — a 500, not a sentence. Both are refused, naming the plan; undoing the
 * conversion first lets the charge go.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, queryOne, type DB } from "../db/db.ts";
import { undoEvent, type Actor } from "../core/events.ts";
import { nowIST, todayIST, monthOf } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import { Refusal } from "../core/refusal.ts";
import { createAccount } from "./accounts.ts";
import { createGroup, createCategory, setAssigned } from "./budget.ts";
import { createTransaction, deleteTransaction, getTransaction, UndoRefused } from "./transactions.ts";
import { convertToEmi } from "./card-emi.ts";
import { identityProblems } from "../engine/identity.test-data.ts";

const actor: Actor = { memberId: "m-ravi", source: "ui" };
const MONTH = monthOf(todayIST());

function converted() {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    "m-ravi", "ravi@example.com", "Ravi", nowIST());
  createAccount(db, actor, {
    name: "ZZ current", kind: "budget", subtype: "savings",
    openingBalance: rupees(2_00_000), openingDate: todayIST(),
  });
  const card = createAccount(db, actor, {
    name: "ZZ Card", kind: "credit", subtype: "credit-card",
    institution: "ZZ Bank", openingDate: todayIST(), statementDay: 18, dueDay: 5,
  });
  const g = createGroup(db, actor, "Spending");
  const electronics = createCategory(db, actor, { groupId: g.id, name: "ZZ Electronics" });
  setAssigned(db, actor, MONTH, electronics.id, rupees(60_000));
  const charge = createTransaction(db, actor, {
    accountId: card.id, amount: -rupees(60_000), date: todayIST(),
    categoryId: electronics.id, payeeName: "ZZ Store",
  });
  const plan = convertToEmi(db, actor, { transactionId: charge.id, tenureMonths: 6, annualRatePct: 15 }).loan;
  return { db, charge: charge.id, plan: plan.id };
}

const eventId = (db: DB, entity: string, entityId: string, action: string) =>
  queryOne<{ id: string }>(db,
    `SELECT id FROM events WHERE entity = ? AND entity_id = ? AND action = ? ORDER BY seq DESC LIMIT 1`,
    entity, entityId, action)!.id;

describe("EXTRA-4 · deleting a charge that was converted to EMI", () => {
  test("the delete is refused, naming the plan, and nothing moves", () => {
    const { db, charge } = converted();
    assert.throws(() => deleteTransaction(db, actor, charge), (err: Error) =>
      err instanceof Refusal && /EMI plan "ZZ Card EMI"/.test(err.message));
    assert.equal(getTransaction(db, charge)!.deleted_at, null);
    assert.deepEqual(identityProblems(db, MONTH), []);
  });

  test("undoing the charge's create is refused the same way, not a foreign-key failure", () => {
    const { db, charge } = converted();
    assert.throws(() => undoEvent(db, eventId(db, "transaction", charge, "create"), actor, { force: true }),
      (err: Error) => err instanceof UndoRefused && /EMI plan "ZZ Card EMI"/.test(err.message));
    assert.ok(getTransaction(db, charge));
  });

  test("once the conversion is undone, the charge deletes and the identity holds", () => {
    const { db, charge, plan } = converted();
    assert.ok(undoEvent(db, eventId(db, "loan", plan, "convert-to-emi"), actor, { force: true }).ok);
    deleteTransaction(db, actor, charge);
    assert.ok(getTransaction(db, charge)!.deleted_at);
    assert.deepEqual(identityProblems(db, MONTH), []);
  });
});
