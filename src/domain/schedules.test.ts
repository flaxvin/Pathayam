/**
 * The question every household with a card asks: what happens to a payment due
 * on the 31st, in February?
 *
 * Three fields in the app answer it differently, and on purpose. A **card due
 * day** clamps to the last day — the bank wants paying in February too. A
 * **schedule** carries its own policy, because a standing instruction may
 * genuinely skip a short month or roll into the next. A **statement day** is a
 * note of the cycle and is never resolved to a date by anything, so the question
 * does not arise for it at all.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, type DB } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import { createAccount } from "./accounts.ts";
import { projectCashflow } from "./schedules.ts";

const actor: Actor = { memberId: "m", source: "ui" };

function setup(): DB {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    "m", "f@e.com", "F", nowIST());
  return db;
}

describe("A card due on the 31st, in a month that has no 31st", () => {
  test("the projection puts it on the last day of February", () => {
    const db = setup();
    createAccount(db, actor, {
      name: "Joint current", kind: "budget", subtype: "savings",
      openingBalance: rupees(1_00_000), openingDate: "2026-01-01",
    });
    createAccount(db, actor, {
      name: "HDFC Regalia", kind: "credit", subtype: "credit-card",
      openingBalance: -rupees(12_000), openingDate: "2026-01-01",
      dueDay: 31,
    });

    // Standing on 1 February, looking far enough ahead to see March too.
    const flow = projectCashflow(db, { days: 60, today: "2026-02-01" });
    const dues = flow.days
      .filter((d) => d.outflows.some((o) => o.label.includes("HDFC Regalia")))
      .map((d) => d.date);

    assert.ok(dues.includes("2026-02-28"), `expected 28 Feb, got ${dues.join(", ")}`);
    assert.ok(dues.includes("2026-03-31"), "and the 31st where the month has one");
    assert.equal(dues.some((d) => d > "2026-02-28" && d < "2026-03-01"), false);
    db.close();
  });

  test("in a leap year it is the 29th", () => {
    const db = setup();
    createAccount(db, actor, {
      name: "Joint current", kind: "budget", subtype: "savings",
      openingBalance: rupees(1_00_000), openingDate: "2024-01-01",
    });
    createAccount(db, actor, {
      name: "HDFC Regalia", kind: "credit", subtype: "credit-card",
      openingBalance: -rupees(12_000), openingDate: "2024-01-01", dueDay: 31,
    });

    const flow = projectCashflow(db, { days: 40, today: "2024-02-01" });
    const dues = flow.days
      .filter((d) => d.outflows.some((o) => o.label.includes("HDFC Regalia")))
      .map((d) => d.date);
    assert.ok(dues.includes("2024-02-29"), `expected 29 Feb, got ${dues.join(", ")}`);
    db.close();
  });
});
