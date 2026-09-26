/**
 * MONEY-CORE-21 · A shared payee's figures count only what the viewer may see.
 *
 * listPayees is filtered so that a merchant seen only on somebody's private
 * account is not given away. The figures beside a shared one were not: Ravi's
 * /payees said "2 transactions · ₹45,801 total" for a Zomato he had spent ₹123
 * at, and his Add form carried ₹45,678 on 20-09 as its last amount — Priya's
 * private spend, amount and date. The raw bank strings listed as aliases were
 * the same leak in her statement's own words.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { freshHousehold, RAVI, PRIYA } from "../engine/identity.test-data.ts";
import { createAccount } from "../domain/accounts.ts";
import { createTransaction, payeeStats } from "../domain/transactions.ts";
import { startTestApp } from "./harness.test-data.ts";

const ravi = { memberId: RAVI, source: "ui" as const };
const priya = { memberId: PRIYA, source: "ui" as const };

function household() {
  const db = freshHousehold();
  const joint = createAccount(db, ravi, {
    name: "Joint", kind: "budget", subtype: "savings", openingDate: "2026-01-01", openingBalance: 1_000_000,
  }).id;
  const secret = createAccount(db, priya, {
    name: "P private", kind: "tracking", subtype: "savings", openingDate: "2026-01-01",
    openingBalance: 5_000_000, holderMemberId: PRIYA, visibility: "private",
  }).id;
  const mine = createTransaction(db, ravi, {
    accountId: joint, amount: -12_300, date: "2026-09-01", payeeName: "Zomato",
    raw: { payee: "UPI-ZOMATO-JOINT" },
  });
  createTransaction(db, priya, {
    accountId: secret, amount: -4_567_800, date: "2026-09-20", payeeName: "Zomato",
    raw: { payee: "UPI-ZOMATO-PRIVATE" },
  });
  return { db, payeeId: mine.payee_id! };
}

describe("MONEY-CORE-21 · payee figures and another member's private spending", () => {
  test("payeeStats counts only the viewer's visible transactions", () => {
    const { db, payeeId } = household();
    const seen = payeeStats(db, payeeId, RAVI);
    assert.deepEqual(
      [seen.count, seen.total, seen.lastSeen, seen.lastAmount],
      [1, -12_300, "2026-09-01", -12_300],
    );
    // Priya sees both; with no viewer (an export) it is everything.
    assert.equal(payeeStats(db, payeeId, PRIYA).count, 2);
    assert.equal(payeeStats(db, payeeId).count, 2);
    db.close();
  });

  test("/payees and the Add form's hints leave Priya's spend out", async () => {
    const { db } = household();
    const app = await startTestApp(db, { memberId: RAVI });
    try {
      const payees = await (await app.get("/payees")).text();
      assert.match(payees, /1 transactions · ₹123 total/);
      assert.doesNotMatch(payees, /20-09-2026|45,678/);
      assert.match(payees, /UPI-ZOMATO-JOINT/);
      assert.doesNotMatch(payees, /UPI-ZOMATO-PRIVATE/);

      const add = await (await app.get("/add")).text();
      assert.doesNotMatch(add, /4567800|45,?678/);
      assert.doesNotMatch(add, /2026-09-20/);
      assert.deepEqual(app.failures, []);
    } finally { await app.close(); }
  });
});
