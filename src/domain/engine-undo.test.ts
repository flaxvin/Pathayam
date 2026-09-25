/**
 * Undo paths that could leave the budget's books unbalanced, or reach the
 * household as a raw "FOREIGN KEY constraint failed" 500.
 *
 * Every case asserts the identity in every scope, live and through the rollup,
 * after the undo — the only check a half-working undo cannot pass.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { queryOne, queryAll, type DB } from "../db/db.ts";
import { undoEvent, type Actor } from "../core/events.ts";
import { createAccount } from "./accounts.ts";
import { createTransfer } from "./transactions.ts";
import { freshHousehold, identityProblems, RAVI } from "../engine/identity.test-data.ts";

const actor: Actor = { memberId: RAVI, source: "ui" };

/** The newest event of this kind about this row. */
function eventFor(db: DB, entity: string, entityId: string, action: string): string {
  const row = queryOne<{ id: string }>(
    db,
    `SELECT id FROM events WHERE entity = ? AND entity_id = ? AND action = ?
      ORDER BY seq DESC LIMIT 1`,
    entity, entityId, action,
  );
  assert.ok(row, `no ${entity}/${action} event for ${entityId}`);
  return row.id;
}

function bankAndCard() {
  const db = freshHousehold();
  const bank = createAccount(db, actor, {
    name: "Bank", kind: "budget", subtype: "savings",
    openingDate: "2025-01-01", openingBalance: 10_000_000,
  }).id;
  const card = createAccount(db, actor, {
    name: "Card", kind: "credit", subtype: "credit-card", openingDate: "2025-01-01",
  }).id;
  return { db, bank, card };
}

/*
 * D13 · createTransfer logs a create event per leg. Undoing the bank leg's
 * create of a ₹123.45 card payment removed only that leg: the card kept a
 * ₹123.45 credit with no bank side, and the identity was out by −12,345 paise
 * from 2026-03 on (+12,345 for bank → card, undoing the bank leg).
 */
describe("D13 · undoing one leg's create removes the transfer", () => {
  for (const which of ["out", "back"] as const) {
    for (const [label, direction] of [["card → bank", "card-out"], ["bank → card", "bank-out"]] as const) {
      test(`${label}, undoing the ${which === "out" ? "sending" : "receiving"} leg`, () => {
        const { db, bank, card } = bankAndCard();
        const [out, back] = createTransfer(db, actor, {
          fromAccountId: direction === "card-out" ? card : bank,
          toAccountId: direction === "card-out" ? bank : card,
          amount: 12_345, date: "2026-03-28",
        });
        const leg = which === "out" ? out : back;

        const result = undoEvent(db, eventFor(db, "transaction", leg.id, "create"), actor);
        assert.equal(result.ok, true);

        const left = queryAll(
          db, `SELECT id FROM transactions WHERE transfer_pair_id = ?`, out.transfer_pair_id,
        );
        assert.equal(left.length, 0, "both legs go");
        assert.deepEqual(identityProblems(db, "2027-03"), []);
      });
    }
  }
});
