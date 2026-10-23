/**
 * DEBUG-ENGINE-1 · The cashflow projection counts only cash the viewer may see.
 *
 * Asked with no budget (the Overview asks that way), the projection summed every
 * open Budget account and listed every open card — including another member's
 * private account and card in their own budget. Priya's "lowest you get" then
 * carried Ravi's private balance, and his private card's name and what it owed
 * appeared as a "due" outflow on her screen.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import { createAccount } from "./accounts.ts";
import { ensurePersonalBudget } from "./budgets.ts";
import { createTransaction } from "./transactions.ts";
import { projectCashflow } from "./schedules.ts";

const RAVI = "m-ravi";
const PRIYA = "m-priya";
const ravi: Actor = { memberId: RAVI, source: "ui" };

test("another member's private account and card stay out of the projection", () => {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  for (const [id, name] of [[RAVI, "Ravi"], [PRIYA, "Priya"]] as const) {
    execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
      id, `${name.toLowerCase()}@example.com`, name, nowIST());
  }
  createAccount(db, ravi, {
    name: "Household bank", kind: "budget", subtype: "savings",
    openingDate: "2026-01-01", openingBalance: rupees(10_000),
  });
  const mine = ensurePersonalBudget(db, RAVI, "Ravi");
  createAccount(db, ravi, {
    name: "Ravi secret savings", kind: "budget", subtype: "savings",
    visibility: "private", holderMemberId: RAVI, budgetId: mine.id,
    openingDate: "2026-01-01", openingBalance: rupees(77_777),
  });
  const card = createAccount(db, ravi, {
    name: "Ravi secret card", kind: "credit", subtype: "credit-card",
    visibility: "private", holderMemberId: RAVI, budgetId: mine.id,
    openingDate: "2026-01-01", dueDay: 20,
  });
  execute(db,
    `INSERT INTO transactions (id, account_id, date, amount, cleared, created_at, updated_at)
     VALUES ('t-card', ?, '2026-03-02', ?, 0, ?, ?)`,
    card.id, -rupees(1_234), nowIST(), nowIST());

  const seen = projectCashflow(db, { today: "2026-03-05", viewerMemberId: PRIYA });
  assert.equal(seen.openingBalance, rupees(10_000), "only the cash Priya may see");
  assert.doesNotMatch(JSON.stringify(seen), /Ravi secret/);
  assert.equal(seen.lowestBalance, rupees(10_000));

  // Ravi still sees his own.
  const his = projectCashflow(db, { today: "2026-03-05", viewerMemberId: RAVI });
  assert.equal(his.openingBalance, rupees(87_777));
  assert.match(JSON.stringify(his), /Ravi secret card due/);
  db.close();
});
