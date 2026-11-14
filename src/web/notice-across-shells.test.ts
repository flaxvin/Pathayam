/**
 * td-UI-1 · "Build my starting budget" on the bare first-run screen answered
 * "21 categories ready. Now add the account your salary lands in", and nobody
 * ever saw it. The script swaps pages in place and prints the message itself,
 * but a bare screen has no chrome to swap into, so it navigated for real to
 * the redirect — and the message, which only lived in the script, went with
 * the old page. The answer now also carries the redirect with the notice
 * signed into it, and that is where a real navigation goes.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";
import { CLIENT_SCRIPT } from "./client.ts";
import { createAccount } from "../domain/accounts.ts";
import { createTransaction } from "../domain/transactions.ts";
import { rupees, type Paise } from "../core/money.ts";
import { todayIST, monthOf } from "../core/dates.ts";

/*
 * td-UI-6 · Editing a transaction said "Saved." twice, and deleting one said
 * "Saved." above "Deleted. You can restore it for the next 30 days.". Those
 * routes answer with a redirect that already carries its notice, which the
 * fetched page shows; the script added its own "Saved." on top.
 */
describe("td-UI-6 · one notice per save", () => {
  test("an edit answers with a redirect that carries its notice and no separate message", async () => {
    const db = freshDb();
    seedMember(db, "m-meera", "Meera");
    const actor = { memberId: "m-meera", source: "ui" as const };
    const cash = createAccount(db, actor, {
      name: "Cash", kind: "budget", subtype: "cash",
      openingDate: `${monthOf(todayIST())}-01`, openingBalance: rupees(3_500),
    });
    const tx = createTransaction(db, actor, { accountId: cash.id, amount: -rupees(120) as Paise, date: todayIST() });
    const app = await startTestApp(db, { memberId: "m-meera" });
    try {
      const res = await app.post(`/transaction/${tx.id}`, { amount: "130", memo: "chai" }, {
        headers: { Accept: "application/json" },
      });
      const body = await res.json() as { redirect: string; message?: string };
      assert.match(body.redirect, /[?&]notice=Saved\./);
      assert.equal(body.message, undefined);
    } finally {
      await app.close();
    }
  });

  test("the script adds no 'Saved.' of its own to a redirect that carries a notice", () => {
    assert.match(CLIENT_SCRIPT, /var carriesNotice = \/\[\?&\]notice=\/\.test\(payload\.redirect\);/);
    assert.match(CLIENT_SCRIPT, /payload\.message \|\| \(carriesNotice \? null : "Saved\."\)/);
    assert.doesNotMatch(CLIENT_SCRIPT, /updatePage\(payload\.redirect, payload\.message \|\| "Saved\."/);
  });
});

describe("td-UI-1 · a message survives a post from a bare screen", () => {
  test("the JSON answer carries the redirect with its notice signed in", async () => {
    const db = freshDb();
    seedMember(db, "m-meera", "Meera");
    const app = await startTestApp(db, { memberId: "m-meera" });
    try {
      const res = await app.post("/setup", { monthly_income: "120000" }, {
        headers: { Accept: "application/json" },
      });
      assert.equal(res.status, 200);
      const body = await res.json() as { redirect: string; message: string; location?: string };
      assert.equal(body.redirect, "/accounts/new");
      assert.match(body.message, /categories ready/);
      assert.ok(body.location, "a location to navigate to");
      const where = new URL(body.location!, "http://x");
      assert.equal(where.pathname, "/accounts/new");
      assert.equal(where.searchParams.get("notice"), body.message);
      assert.ok(where.searchParams.get("ns"), "signed, so the page will show it");

      // And the page at that address shows it.
      const page = await (await app.get(body.location!)).text();
      assert.match(page, /categories ready/);
    } finally {
      await app.close();
    }
  });

  test("the script navigates to that address when it cannot swap", () => {
    assert.match(CLIENT_SCRIPT, /function updatePage\(url, message, kind, onFail, markup, noticeUrl\)/);
    assert.match(CLIENT_SCRIPT, /var away = noticeUrl \|\| url;/);
    const update = CLIENT_SCRIPT.slice(CLIENT_SCRIPT.indexOf("function updatePage("), CLIENT_SCRIPT.indexOf("function submitWithRetry("));
    assert.doesNotMatch(update, /window\.location\.href = url;/, "every real navigation keeps the message");
    assert.match(CLIENT_SCRIPT, /updatePage\(payload\.redirect, [^;]*payload\.location\)/);
  });
});
