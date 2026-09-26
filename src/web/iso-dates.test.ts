/**
 * L3 · Every date the app shows reads DD-MM-YYYY.
 *
 * The stored form is ISO (YYYY-MM-DD), and a template that interpolates a
 * stored date directly shows it that way — which is how the transaction page
 * came to say "on 26-09-2026" one line above "2026-09-26 · Ravi". Each screen
 * below once did exactly that (WEBUX-1); this renders them and looks for an
 * ISO date anywhere in the text a person reads, including the <title> tooltips
 * of the reports heatmap. Attribute values (form fields, links) stay ISO and
 * are not looked at: tags are stripped first.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { queryOne } from "../db/db.ts";
import { rupees } from "../core/money.ts";
import type { Actor } from "../core/events.ts";
import { todayIST, addDays, formatDate } from "../core/dates.ts";
import { createAccount, recordCardStatement } from "../domain/accounts.ts";
import { createGroup, createCategory, setTarget } from "../domain/budget.ts";
import { createTransaction } from "../domain/transactions.ts";
import { createAssetAccount, recordValuation } from "../domain/assets.ts";
import { mintToken } from "../auth/tokens.ts";
import { staleRatesWarning, NEWEST_KNOWN_FY } from "../domain/tax.ts";
import { startTestApp, seedMember, freshDb, type TestApp } from "./harness.test-data.ts";

const actor: Actor = { memberId: "m", source: "ui" };
const ISO = /\b\d{4}-\d{2}-\d{2}\b/;

/** What a person reads: no scripts, styles or attributes. */
function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
}

describe("WEBUX-1 · no screen shows a raw ISO date", () => {
  let app: TestApp;
  const ids: Record<string, string> = {};
  const today = todayIST();

  before(async () => {
    const db = freshDb();
    seedMember(db);
    const bank = createAccount(db, actor, {
      name: "Canara Savings", kind: "budget", subtype: "savings",
      openingDate: addDays(today, -60), openingBalance: rupees(90000),
    });
    const card = createAccount(db, actor, {
      name: "Atlas", kind: "credit", subtype: "credit-card",
      openingDate: addDays(today, -60), openingBalance: rupees(0),
    });
    const group = createGroup(db, actor, "Flexible");
    const groceries = createCategory(db, actor, { groupId: group.id, name: "Groceries" }).id;
    // The event summary, read back on /activity.
    setTarget(db, actor, groceries, { type: "by-date", amount: rupees(5000), targetDate: addDays(today, 90) });
    const txn = createTransaction(db, actor, {
      accountId: bank.id, amount: -rupees(1200), date: today,
      categoryId: groceries, payeeName: "Kirana",
    });
    recordCardStatement(db, actor, {
      accountId: card.id, statementDate: today, dueDate: addDays(today, 18), amount: rupees(4000),
    });
    const gold = createAssetAccount(db, actor, { name: "Gold", subtype: "commodity" });
    recordValuation(db, actor, { accountId: gold.id, value: rupees(150000), asOf: today });
    const token = mintToken(db, actor, { name: "Export script", scope: "read", expiresInDays: 90 });
    // A token that has been used, so "Last used" is a date rather than "Never".
    queryOne(db, `UPDATE api_tokens SET last_used_at = created_at WHERE id = ? RETURNING id`, token.token.id);
    Object.assign(ids, { txn: txn.id, gold: gold.id });
    app = await startTestApp(db);
  });

  after(async () => {
    await app?.close();
  });

  const pages = () => [
    `/transaction/${ids.txn}`, // header and History
    "/settings",               // devices: "Last seen"
    "/tokens",                 // "Created" and "Last used"
    "/tax",                    // rates "last checked on"
    "/health",                 // tax check "Last checked"
    "/activity",               // card statement ", due …" and target " by …"
    "/reports",                // heatmap cell titles
    `/portfolio/asset/${ids.gold}/add`,
    `/portfolio/asset/${ids.gold}/dispose`,
  ];

  test("each screen shows DD-MM-YYYY, not YYYY-MM-DD", async () => {
    const found: string[] = [];
    for (const path of pages()) {
      const res = await app.get(path);
      assert.equal(res.status, 200, path);
      const text = visibleText(await res.text());
      const hit = text.match(new RegExp(`.{0,40}${ISO.source}.{0,20}`));
      if (hit) found.push(`${path}: …${hit[0]}…`);
    }
    assert.deepEqual(found, []);
    assert.deepEqual(app.failures, []);
  });

  test("the transaction page's header carries the DD-MM-YYYY date", async () => {
    const text = visibleText(await (await app.get(`/transaction/${ids.txn}`)).text());
    assert.ok(text.includes(`Canara Savings · ${formatDate(today)}`), text.slice(0, 400));
  });

  test("the stale-rates sentence says when the rates were checked in DD-MM-YYYY", () => {
    const warning = staleRatesWarning(NEWEST_KNOWN_FY + 1)!;
    assert.match(warning, /last checked on \d{2}-\d{2}-\d{4}\./);
    assert.doesNotMatch(warning, ISO);
  });
});
