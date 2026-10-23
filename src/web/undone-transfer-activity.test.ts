/**
 * D8d · Activity offers no Undo it would refuse.
 *
 * A transfer writes three events: the transfer's own, and a create for each
 * leg. Once the transfer was undone, both legs were gone — but their creates
 * still showed an Undo button, and pressing it answered "That transfer has
 * already been removed." The check that decides whether to offer the button
 * now asks the same question the undo itself does.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";
import { createAccount } from "../domain/accounts.ts";
import { createTransfer } from "../domain/transactions.ts";
import { checkUndo, queryEvents, undoEvent } from "../core/events.ts";
import { rupees, type Paise } from "../core/money.ts";

const actor = { memberId: "m-ravi", source: "ui" as const };

function setup() {
  const db = freshDb();
  seedMember(db, "m-ravi", "Ravi");
  const bank = createAccount(db, actor, {
    name: "Bank", kind: "budget", subtype: "savings", openingDate: "2026-08-01", openingBalance: rupees(10_000),
  }).id;
  const wallet = createAccount(db, actor, {
    name: "Wallet", kind: "budget", subtype: "cash", openingDate: "2026-08-01", openingBalance: 0,
  }).id;
  createTransfer(db, actor, { fromAccountId: bank, toAccountId: wallet, amount: rupees(1_000) as Paise });
  const transferEvent = queryEvents(db, { entity: "transfer", action: "create" })[0]!;
  const legEvents = queryEvents(db, { entity: "transaction", action: "create" });
  assert.equal(legEvents.length, 2);
  return { db, transferEvent, legEvents };
}

describe("D8d · undone transfers offer no Undo on their legs", () => {
  test("before anything is undone, every part may be undone", () => {
    const { db, transferEvent, legEvents } = setup();
    for (const e of [transferEvent, ...legEvents]) assert.equal(checkUndo(db, e.id).ok, true);
  });

  test("after the transfer's own undo, its legs are not offered", async () => {
    const { db, transferEvent, legEvents } = setup();
    assert.equal(undoEvent(db, transferEvent.id, actor).ok, true);
    for (const e of legEvents) {
      const check = checkUndo(db, e.id);
      assert.equal(check.ok, false);
      assert.match(check.reason ?? "", /already been removed/);
    }

    const app = await startTestApp(db, { memberId: "m-ravi" });
    try {
      const page = await (await app.get("/activity")).text();
      for (const e of legEvents) {
        assert.ok(!page.includes(`/activity/${e.id}/undo`), "an Undo the server would refuse is offered");
      }
      assert.match(page, /That transfer has already been removed\./);
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });

  test("after one leg's undo, neither the other leg nor the transfer is offered", () => {
    const { db, transferEvent, legEvents } = setup();
    assert.equal(undoEvent(db, legEvents[0]!.id, actor).ok, true);
    assert.equal(checkUndo(db, legEvents[1]!.id).ok, false);
    assert.equal(checkUndo(db, transferEvent.id).ok, false);
  });
});
