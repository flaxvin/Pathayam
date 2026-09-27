/**
 * Undoing an assignment after its envelope was merged away.
 *
 * Found by the round-2 fuzzer: assign ₹300 then ₹500 to A, merge A into B,
 * force-undo the ₹500, and the handler wrote ₹300 back onto A's tombstone — a
 * row the engine never reads, so the household's accounts and its envelopes
 * were out by ₹300 in every month after. The undo is refused, by name.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { queryOne } from "../db/db.ts";
import { undoEvent, type Actor } from "../core/events.ts";
import { Refusal } from "../core/refusal.ts";
import { createAccount } from "./accounts.ts";
import { createGroup, createCategory, setAssigned, mergeCategories } from "./budget.ts";
import { freshHousehold, identityProblems, RAVI } from "../engine/identity.test-data.ts";

const actor: Actor = { memberId: RAVI, source: "ui" };

test("an assignment's undo is refused once its envelope has been merged away", () => {
  const db = freshHousehold();
  createAccount(db, actor, {
    name: "Bank", kind: "budget", subtype: "savings", openingDate: "2025-01-01", openingBalance: 1_000_000,
  });
  const group = createGroup(db, actor, "Everyday").id;
  const a = createCategory(db, actor, { groupId: group, name: "A" }).id;
  const b = createCategory(db, actor, { groupId: group, name: "B" }).id;
  setAssigned(db, actor, "2025-02", a, 30_000);
  setAssigned(db, actor, "2025-02", a, 50_000);
  const second = queryOne<{ id: string }>(db, `SELECT id FROM events ORDER BY seq DESC LIMIT 1`)!.id;
  setAssigned(db, actor, "2025-02", b, 10_000);
  mergeCategories(db, actor, a, b);

  assert.throws(() => undoEvent(db, second, actor, { force: true }), (err: unknown) =>
    err instanceof Refusal && /"A" has been merged or deleted since/.test(err.message));
  assert.deepEqual(identityProblems(db, "2025-06"), []);
});
