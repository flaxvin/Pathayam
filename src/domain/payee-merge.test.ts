/**
 * A merge names two live payees, never one already merged away.
 *
 * Merging "D-Mart Ltd" into "DMart" and then — from a second tab, or the list
 * as it stood before the first merge — "DMart" back into "D-Mart Ltd" was
 * accepted: both rows then pointed at each other, both dropped out of every
 * list, and a new "DMart" transaction attached to a payee nobody could see,
 * rename or merge again (MONEY-CORE-13).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember } from "../web/harness.test-data.ts";
import { mergePayees, resolvePayee, listPayees } from "./transactions.ts";
import { Refusal } from "../core/refusal.ts";
import { queryAll } from "../db/db.ts";

const actor = { memberId: "m-ravi", source: "ui" as const };

test("MONEY-CORE-13 · merging back the other way is refused, not a cycle", () => {
  const db = freshDb();
  seedMember(db, "m-ravi", "Ravi");
  const ltd = resolvePayee(db, actor, "D-Mart Ltd").id;
  const dmart = resolvePayee(db, actor, "DMart").id;

  mergePayees(db, actor, ltd, dmart);
  assert.throws(() => mergePayees(db, actor, dmart, ltd), Refusal);
  // Nor with the merged-away payee as the loser a second time.
  const other = resolvePayee(db, actor, "Dee Mart").id;
  assert.throws(() => mergePayees(db, actor, ltd, other), Refusal);

  assert.deepEqual(
    queryAll<{ id: string }>(db, `SELECT id FROM payees WHERE merged_into_id IS NOT NULL`).map((r) => r.id),
    [ltd],
  );
  assert.ok(listPayees(db).some((p) => p.id === dmart), "DMart is still listed");
});
