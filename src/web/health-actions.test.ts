/**
 * WEBUX-8 · The health page's "Open" goes to the review queue.
 *
 * Every check action was rendered as a POST form, which is right for "Back up
 * now" and "Verify now" and wrong for the review queue's "Open": it posted to
 * /review, a page that only answers GET, and landed on "Something went wrong —
 * That action is not allowed here" (405).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";
import { createAccount } from "../domain/accounts.ts";
import { createTransaction } from "../domain/transactions.ts";
import { rupees } from "../core/money.ts";
import { todayIST } from "../core/dates.ts";
import type { Actor } from "../core/events.ts";

const RAVI = "m-ravi";
const ravi: Actor = { memberId: RAVI, source: "ui" };

describe("WEBUX-8 · health check actions", () => {
  test("Open is a link to the queue; the jobs stay buttons that post", async () => {
    const db = freshDb();
    seedMember(db, RAVI, "Ravi");
    const account = createAccount(db, ravi, {
      name: "Joint current", kind: "budget", subtype: "savings",
      openingDate: "2026-01-01", openingBalance: rupees(10_000),
    });
    // Nothing filed, so the queue has something waiting.
    createTransaction(db, ravi, { accountId: account.id, amount: -rupees(250), date: todayIST() });

    const app = await startTestApp(db, { memberId: RAVI });
    try {
      const body = (await (await app.get("/health")).text()).replace(/\s+/g, " ");
      assert.match(body, /<a class="button button-small" href="\/review">Open<\/a>/);
      assert.doesNotMatch(body, /<form method="post" action="\/review">/, "Open still posts to a page");
      assert.match(body, /<form method="post" action="\/health\/backup">/, "Back up now stopped being a post");
      assert.equal((await app.get("/review")).status, 200);
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });
});
