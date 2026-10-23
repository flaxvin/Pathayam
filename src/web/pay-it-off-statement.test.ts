/**
 * D8c · "Pay it off" fills what the statement asks for.
 *
 * The button filled the card's whole balance, so a card with a ₹3,000
 * statement and ₹2,000 of fresh spending since offered to pay ₹5,000 — money
 * the bank has not billed yet, out of an account that may need it before the
 * next statement. With a statement recorded it now fills what is left of that
 * statement; with none, or one already paid, the balance as before.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";
import { createAccount, recordCardStatement } from "../domain/accounts.ts";
import { createTransfer } from "../domain/transactions.ts";
import { rupees, type Paise } from "../core/money.ts";

const actor = { memberId: "m-ravi", source: "ui" as const };

function setup() {
  const db = freshDb();
  seedMember(db, "m-ravi", "Ravi");
  const bank = createAccount(db, actor, {
    name: "HDFC", kind: "budget", subtype: "savings",
    openingDate: "2026-08-01", openingBalance: rupees(100_000),
  }).id;
  const card = createAccount(db, actor, {
    name: "Card", kind: "credit", subtype: "credit-card",
    openingDate: "2026-08-01", openingBalance: -rupees(5_000),
    statementDay: 18, dueDay: 8,
  }).id;
  return { db, bank, card };
}

async function payItOffAmount(db: ReturnType<typeof freshDb>): Promise<string | undefined> {
  const app = await startTestApp(db, { memberId: "m-ravi" });
  try {
    const cards = await (await app.get("/cards")).text();
    assert.deepEqual(app.failures, []);
    return /href="\/transfer\?to=[^"]*amount=([0-9.]+)"[^>]*>\s*Pay it off/.exec(cards)?.[1];
  } finally {
    await app.close();
  }
}

describe("D8c · Pay it off", () => {
  test("with no statement, it fills the balance", async () => {
    const { db } = setup();
    assert.equal(await payItOffAmount(db), "5000.00");
  });

  test("with a statement, it fills the statement", async () => {
    const { db, card } = setup();
    recordCardStatement(db, actor, {
      accountId: card, statementDate: "2026-10-18", dueDate: "2026-11-08", amount: rupees(3_000) as Paise,
    });
    assert.equal(await payItOffAmount(db), "3000.00");
  });

  test("part-paid, it fills what is left of the statement", async () => {
    const { db, bank, card } = setup();
    recordCardStatement(db, actor, {
      accountId: card, statementDate: "2026-10-18", dueDate: "2026-11-08", amount: rupees(3_000) as Paise,
    });
    createTransfer(db, actor, { fromAccountId: bank, toAccountId: card, amount: rupees(1_000) as Paise, date: "2026-10-20" });
    assert.equal(await payItOffAmount(db), "2000.00");
  });

  test("with the statement paid, it falls back to the balance", async () => {
    const { db, bank, card } = setup();
    recordCardStatement(db, actor, {
      accountId: card, statementDate: "2026-10-18", dueDate: "2026-11-08", amount: rupees(3_000) as Paise,
    });
    createTransfer(db, actor, { fromAccountId: bank, toAccountId: card, amount: rupees(3_000) as Paise, date: "2026-10-20" });
    assert.equal(await payItOffAmount(db), "2000.00");
  });
});
