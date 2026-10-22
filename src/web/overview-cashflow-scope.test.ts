/**
 * DEBUG-ENGINE-9 · The Overview's "Will you make it?" is about the budget on
 * screen. It projected every budget's cash together, so the household's
 * Overview read Ravi's personal savings as money the household could spend.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";
import type { Actor } from "../core/events.ts";
import { rupees, formatPaise, type Paise } from "../core/money.ts";
import { createAccount } from "../domain/accounts.ts";
import { ensurePersonalBudget, householdBudgetId } from "../domain/budgets.ts";

test("the household Overview projects only the household's cash", async () => {
  const db = freshDb();
  seedMember(db, "m-ravi", "Ravi");
  const ravi: Actor = { memberId: "m-ravi", source: "ui" };
  createAccount(db, ravi, {
    name: "Joint current", kind: "budget", subtype: "savings",
    openingDate: "2025-01-01", openingBalance: rupees(50_000) as Paise,
  });
  const his = ensurePersonalBudget(db, "m-ravi", "Ravi");
  createAccount(db, ravi, {
    name: "Ravi savings", kind: "budget", subtype: "savings",
    openingDate: "2025-01-01", openingBalance: rupees(3_00_000) as Paise,
    holderMemberId: "m-ravi", budgetId: his.id,
  });
  const app = await startTestApp(db, { memberId: "m-ravi" });
  try {
    const household = await (await app.get(`/overview?budget=${householdBudgetId(db)}`)).text();
    assert.ok(
      household.includes(`lowest you get is ${formatPaise(rupees(50_000) as Paise)}`),
      household.match(/lowest[^<]*/)?.[0],
    );
    const mine = await (await app.get(`/overview?budget=${his.id}`)).text();
    assert.ok(
      mine.includes(`lowest you get is ${formatPaise(rupees(3_00_000) as Paise)}`),
      mine.match(/lowest[^<]*/)?.[0],
    );
  } finally {
    await app.close();
  }
});
