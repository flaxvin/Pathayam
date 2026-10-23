/**
 * DEBUG-ENGINE-4 · A total is over every row, not the first five hundred.
 *
 * `queryTransactions` stopped at 500 rows unless told otherwise, a cap meant for
 * how much of a table to render. The month close and the reports' spending by
 * envelope both totalled what it returned without lifting it, so a busy month —
 * or "last 12 months" of ordinary use — summed only the newest 500 lines:
 * income, spending and each envelope's figure quietly short, and the close
 * wrote the short figures into month_closes for good.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import { createAccount } from "./accounts.ts";
import { createGroup, createCategory } from "./budget.ts";
import { createTransaction } from "./transactions.ts";
import { queryTransactions } from "./reports.ts";
import { monthCloseView } from "./month-close.ts";

const actor: Actor = { memberId: "m", source: "ui" };

test("the month close and an unbounded query count all 600 lines", () => {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    "m", "ravi@example.com", "Ravi", nowIST());
  const bank = createAccount(db, actor, {
    name: "Bank", kind: "budget", subtype: "savings",
    openingDate: "2026-07-01", openingBalance: rupees(100_000),
  }).id;
  const group = createGroup(db, actor, "Everyday");
  const food = createCategory(db, actor, { groupId: group.id, name: "Food" }).id;
  for (let i = 0; i < 600; i++) {
    createTransaction(db, actor, {
      accountId: bank, amount: -rupees(10), categoryId: food,
      date: `2026-07-${String((i % 28) + 1).padStart(2, "0")}`,
    });
  }

  const rows = queryTransactions(db, { from: "2026-07-01", to: "2026-07-31", direction: "out" });
  assert.equal(rows.length, 600);

  const close = monthCloseView(db, "2026-07", "2026-08-02");
  assert.equal(close.outcome.spending, rupees(6_000));
  assert.equal(close.outcome.transactionCount, 600);
  db.close();
});
