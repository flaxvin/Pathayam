/**
 * WEALTH-31 · Fixed and recurring deposits count towards the FIRE corpus.
 *
 * fire.ts lists deposits as drawable — "an Indian household's safety is often
 * an FD" — but valued accounts without holdings by their stated valuation
 * only, and a deposit never has one: /revalue refuses it, because a stated
 * figure would freeze its interest out. So ₹10 lakh in an FD and ₹2 lakh in an
 * RD were on neither list, and the corpus was 92% short.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute } from "../db/db.ts";
import { nowIST } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import type { Actor } from "../core/events.ts";
import { createAccount } from "./accounts.ts";
import { fireProjection } from "./fire.ts";
import { netWorthStatement } from "./networth.ts";

const actor: Actor = { memberId: "m", source: "ui" };

describe("WEALTH-31 · FIRE and deposits", () => {
  test("an FD and an RD are drawable at their balance, as net worth counts them", () => {
    const db = openDatabase({ path: ":memory:", verbose: false });
    ensureHousehold(db);
    execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`, "m", "f@e.com", "Ravi", nowIST());
    const open = (name: string, kind: string, subtype: string, rs: number) =>
      createAccount(db, actor, {
        name, kind: kind as "budget", subtype, openingDate: "2025-01-01", openingBalance: rupees(rs),
      });
    open("Bank", "budget", "savings", 1_00_000);
    open("Fictional FD", "tracking", "fixed-deposit", 10_00_000);
    open("Fictional RD", "tracking", "recurring-deposit", 2_00_000);
    open("Owed to a fictional friend", "tracking", "liability", -50_000);

    const f = fireProjection(db, { asOf: "2026-09-30" });
    assert.deepEqual(f.drawableLines.map((l) => l.label).sort(), ["Bank", "Fictional FD", "Fictional RD"]);
    assert.equal(f.drawableNow, rupees(13_00_000));
    assert.equal(
      f.drawableNow,
      netWorthStatement(db, "2026-09-30").totalAssets,
      "the two pages agree on what the household holds",
    );
    db.close();
  });
});
