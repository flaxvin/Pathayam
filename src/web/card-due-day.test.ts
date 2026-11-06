/**
 * UI-9 · A card with no statement falls due on its stored due day.
 *
 * Weekly UI pass 04-11-2026: a card owing ₹9,250 with due day 8, four days
 * away, read "Due within a week 0" on Cards, and its panel said nothing of a
 * date — while the cashflow projection already paid it on the 8th. With no
 * statement, both now use the due day, as the projection does.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";
import { createAccount, nextDueByDay } from "../domain/accounts.ts";
import { rupees } from "../core/money.ts";
import { addDays, todayIST, formatDate } from "../core/dates.ts";

const actor = { memberId: "m-ravi", source: "ui" as const };

describe("UI-9 · a card's due day without a statement", () => {
  test("the next due date is this month's due day, or next month's once it has passed", () => {
    assert.equal(nextDueByDay(8, "2026-11-04"), "2026-11-08");
    assert.equal(nextDueByDay(8, "2026-11-08"), "2026-11-08");
    assert.equal(nextDueByDay(8, "2026-11-09"), "2026-12-08");
    assert.equal(nextDueByDay(31, "2027-02-10"), "2027-02-28", "clamped to the month's last day");
    assert.equal(nextDueByDay(30, "2027-01-31"), "2027-02-28");
  });

  test("Cards counts it as due within a week, and the card panel names the date", async () => {
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    const due = addDays(todayIST(), 3);
    const dueDay = Number(due.slice(8));
    const card = createAccount(db, actor, {
      name: "Fictional Card", kind: "credit", subtype: "credit-card",
      openingDate: "2026-08-01", openingBalance: -rupees(9_250), statementDay: 20, dueDay,
    }).id;
    const app = await startTestApp(db, { memberId: "m-ravi" });
    try {
      const cards = await (await app.get("/cards")).text();
      assert.match(cards, /Due within a week<\/div>\s*<strong[^>]*>1<\/strong>/);
      assert.match(cards, /Due in 3 days/);
      assert.match(cards, new RegExp(`due ${formatDate(due)} by the card's due day`));

      const panel = await (await app.get(`/accounts/${card}`)).text();
      assert.match(panel, new RegExp(`due ${formatDate(due)} by the card's due day`));
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });

  test("a card that owes nothing, or has no due day, is not counted", async () => {
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    const dueDay = Number(addDays(todayIST(), 3).slice(8));
    createAccount(db, actor, {
      name: "Fictional Clear Card", kind: "credit", subtype: "credit-card",
      openingDate: "2026-08-01", openingBalance: 0, dueDay,
    });
    createAccount(db, actor, {
      name: "Fictional Undated Card", kind: "credit", subtype: "credit-card",
      openingDate: "2026-08-01", openingBalance: -rupees(1_000),
    });
    const app = await startTestApp(db, { memberId: "m-ravi" });
    try {
      const cards = await (await app.get("/cards")).text();
      assert.match(cards, /Due within a week<\/div>\s*<strong[^>]*>0<\/strong>/);
      assert.doesNotMatch(cards, /by the card's due day/);
    } finally {
      await app.close();
    }
  });
});
