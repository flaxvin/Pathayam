/**
 * DEBUG-ENGINE-11 · Close (and Reopen) act on the budget whose month was on
 * screen. The forms posted no budget, so the handler took whichever budget was
 * opened last — in another tab, say — and closed *that* budget's month while
 * the page being submitted showed the household's figures.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";
import type { Actor } from "../core/events.ts";
import { rupees, type Paise } from "../core/money.ts";
import { createAccount } from "../domain/accounts.ts";
import { createTransaction } from "../domain/transactions.ts";
import { ensurePersonalBudget, householdBudgetId } from "../domain/budgets.ts";
import { isClosed } from "../domain/month-close.ts";

function hiddenFields(page: string, action: string): Record<string, string> {
  const form = page.match(new RegExp(`<form[^>]*action="${action}"[\\s\\S]*?</form>`))?.[0] ?? "";
  const out: Record<string, string> = {};
  for (const m of form.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g)) out[m[1]!] = m[2]!;
  return out;
}

test("closing the household's month closes the household's, whatever tab was opened since", async () => {
  const db = freshDb();
  seedMember(db, "m-ravi", "Ravi");
  const ravi: Actor = { memberId: "m-ravi", source: "ui" };
  const bank = createAccount(db, ravi, {
    name: "Joint", kind: "budget", subtype: "savings",
    openingDate: "2026-07-01", openingBalance: rupees(10_000) as Paise,
  });
  createTransaction(db, ravi, { accountId: bank.id, amount: rupees(100) as Paise, date: "2026-07-03" });
  const his = ensurePersonalBudget(db, "m-ravi", "Ravi");
  const household = householdBudgetId(db);

  const app = await startTestApp(db, { memberId: "m-ravi" });
  try {
    const page = await (await app.get(`/months/2026-07/close?budget=${household}`)).text();
    // Another tab opens Ravi's own budget, which is now the remembered one.
    await app.get(`/?budget=${his.id}`);

    const res = await app.post("/months/2026-07/close", hiddenFields(page, "/months/2026-07/close"));
    assert.equal(res.status, 303);
    assert.equal(isClosed(db, "2026-07", household), true, "the household's month is closed");
    assert.equal(isClosed(db, "2026-07", his.id), false, "Ravi's own month was not touched");

    const closedPage = await (await app.get(`/months/2026-07/close?budget=${household}`)).text();
    await app.get(`/?budget=${his.id}`);
    await app.post("/months/2026-07/reopen", hiddenFields(closedPage, "/months/2026-07/reopen"));
    assert.equal(isClosed(db, "2026-07", household), false, "the household's month is open again");
  } finally {
    await app.close();
  }
});
