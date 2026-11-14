/**
 * UI-12 · Febin's decision 8: no FIRE figure on a short history.
 *
 * Top-down pass 13-11-2026: a household two days old read "You would need
 * ₹46,07,02,061.43" — two days of spending times 182. The estimate now waits
 * for 30 days of history and says on which day it appears; from then until
 * five years it says what history it rests on. The AI export hides the same
 * figures.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";
import { createAccount } from "../domain/accounts.ts";
import { createTransaction } from "../domain/transactions.ts";
import { createGroup, createCategory } from "../domain/budget.ts";
import { fireProjection, historyLength } from "../domain/fire.ts";
import { aiFire } from "../ai/analysis.ts";
import { rupees, type Paise } from "../core/money.ts";
import { todayIST, addDays, formatDate, type IsoDate } from "../core/dates.ts";

const actor = { memberId: "m", source: "ui" as const };

function household(openedOn: IsoDate) {
  const db = freshDb();
  seedMember(db, "m", "Asha");
  const bank = createAccount(db, actor, {
    name: "Savings", kind: "budget", subtype: "savings", openingDate: openedOn, openingBalance: rupees(2_00_000),
  });
  const group = createGroup(db, actor, "Flexible");
  const food = createCategory(db, actor, { groupId: group.id, name: "Groceries" });
  createTransaction(db, actor, { accountId: bank.id, amount: -rupees(25_000) as Paise, categoryId: food.id, date: openedOn });
  return db;
}

describe("UI-12 · the FIRE estimate and its history", () => {
  test("history lengths read as a person says them", () => {
    assert.equal(historyLength("2026-01-01", "2026-01-30"), "30 days");
    assert.equal(historyLength("2026-01-01", "2026-01-31"), "1 month");
    assert.equal(historyLength("2026-01-01", "2026-05-10"), "4 months");
    assert.equal(historyLength("2026-01-01", "2026-12-31"), "1 year");
    assert.equal(historyLength("2024-01-01", "2026-04-15"), "2 years 3 months");
  });

  test("hidden before 30 days, then said what it rests on until five years", () => {
    const db = household("2021-06-01");
    const at = (asOf: IsoDate) => fireProjection(db, { asOf, viewerMemberId: "m" });

    const twoDays = at("2021-06-02");
    assert.equal(twoDays.estimateReady, false);
    assert.equal(twoDays.estimateReadyOn, "2021-06-30");
    assert.equal(twoDays.basedOn, null);
    assert.equal(at("2021-06-29").estimateReady, false, "29 days");

    const thirty = at("2021-06-30");
    assert.equal(thirty.estimateReady, true);
    assert.equal(thirty.historyDays, 30);
    assert.equal(thirty.basedOn, "1 month of spending", "June has 30 days");
    assert.equal(at("2021-10-10").basedOn, "4 months of spending");
    // The window stays a year (FIRE-1); the line says so and how much history there is.
    assert.equal(at("2023-09-15").basedOn, "the last 12 months of spending (2 years 3 months of history)");
    assert.equal(at("2026-05-30").basedOn, "the last 12 months of spending (4 years 11 months of history)");
    assert.equal(at("2026-05-31").basedOn, null, "five years: the line is dropped");
    assert.equal(at("2026-05-31").estimateReady, true);
  });

  test("the page shows a note and the day instead of a target on a two-day history", async () => {
    const opened = addDays(todayIST(), -1);
    const db = household(opened);
    const app = await startTestApp(db, { memberId: "m" });
    try {
      const page = (await (await app.get("/fire")).text()).replace(/\s+/g, " ");
      assert.match(page, /Not enough history yet/);
      assert.ok(page.includes(formatDate(addDays(opened, 29))), "says when it appears");
      assert.doesNotMatch(page, /You would need/);
      assert.doesNotMatch(page, /annualised/);
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });

  test("from 30 days the page shows the target with what it is based on", async () => {
    const db = household(addDays(todayIST(), -44));
    const app = await startTestApp(db, { memberId: "m" });
    try {
      const page = (await (await app.get("/fire")).text()).replace(/\s+/g, " ");
      assert.match(page, /You would need/);
      assert.match(page, /Estimate based on (45 days|1 month) of spending\./);
      assert.doesNotMatch(page, /Not enough history yet/);
    } finally {
      await app.close();
    }
  });

  test("the AI export leaves the target out on a short history", () => {
    const db = household(addDays(todayIST(), -1));
    const f = aiFire(db, "m") as Record<string, unknown>;
    assert.equal(f.estimate_ready, false);
    assert.equal(f.fire_number, null);
    assert.equal(f.annual_expenses, null);
    assert.equal(f.years_to_fire, null);
    assert.equal(f.estimate_appears_on, addDays(todayIST(), 28));
    assert.notEqual(f.corpus, null, "what is held is still given");

    const old = aiFire(household(addDays(todayIST(), -100)), "m") as Record<string, unknown>;
    assert.equal(old.estimate_ready, true);
    assert.notEqual(old.fire_number, null);
  });
});
