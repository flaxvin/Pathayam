/**
 * td-UI-18 · Closing a month whose next month had nothing left to assign read
 * "₹0 ready to assign. Go and assign it" — a link to a job that does not exist.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";
import type { Actor } from "../core/events.ts";
import { rupees, type Paise } from "../core/money.ts";
import { createAccount } from "../domain/accounts.ts";
import { createTransaction } from "../domain/transactions.ts";

const flat = (s: string) => s.replace(/\s+/g, " ");

async function closePage(opening: number): Promise<string> {
  const db = freshDb();
  seedMember(db, "m-ravi", "Ravi");
  const ravi: Actor = { memberId: "m-ravi", source: "ui" };
  const bank = createAccount(db, ravi, {
    name: "Joint", kind: "budget", subtype: "savings",
    openingDate: "2026-07-01", openingBalance: rupees(opening) as Paise,
  });
  createTransaction(db, ravi, { accountId: bank.id, amount: -rupees(0.01) as Paise, date: "2026-07-03" });
  const app = await startTestApp(db, { memberId: "m-ravi" });
  try {
    const page = flat(await (await app.get("/months/2026-07/close")).text());
    assert.deepEqual(app.failures, []);
    return page;
  } finally {
    await app.close();
  }
}

test("with money waiting, the close page says go and assign it", async () => {
  const page = await closePage(10_000);
  assert.match(page, /₹9,999.99<\/strong> ready to assign\. (<!--[^>]*--> )?<a href="\/\?month=2026-08">Go and assign it<\/a>/);
});

test("with nothing waiting, it does not send you to assign ₹0", async () => {
  const page = await closePage(0.01);
  assert.match(page, /₹0<\/strong> ready to assign\./);
  assert.doesNotMatch(page, /Go and assign it/);
  assert.match(page, /Every rupee has a job\./);
});
