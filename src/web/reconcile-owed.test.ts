/**
 * Decision 3 (E4) · Reconciling a card or loan asks how much you owe.
 *
 * A card statement prints "Total due ₹10,000". Typed into "What does the bank
 * say?" against a card the app holds at −₹10,000, the gap read ₹20,000 and
 * "Add a ₹20,000 adjustment" put the card ₹10,000 in credit. Now the field asks
 * "How much does the statement say you owe?" and the typed figure is owed; a
 * card in credit is said with the "in credit" tick or the statement's "Cr".
 * Savings accounts are unchanged.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rupees } from "../core/money.ts";
import type { Actor } from "../core/events.ts";
import type { DB } from "../db/db.ts";
import { queryAll } from "../db/db.ts";
import { createAccount } from "../domain/accounts.ts";
import { startTestApp, seedMember, freshDb, type TestApp } from "./harness.test-data.ts";

const actor: Actor = { memberId: "m", source: "ui" };

let db: DB;
let app: TestApp;
let card: string;
let savings: string;

before(async () => {
  db = freshDb();
  seedMember(db);
  card = createAccount(db, actor, {
    name: "Axis card", kind: "credit", subtype: "credit-card",
    openingDate: "2026-08-01", openingBalance: -rupees(10_000),
  }).id;
  savings = createAccount(db, actor, {
    name: "SBI savings", kind: "budget", subtype: "savings",
    openingDate: "2026-08-01", openingBalance: rupees(10_000),
  }).id;
  app = await startTestApp(db);
});
after(async () => {
  await app.close();
});

const txCount = (account: string) =>
  queryAll(db, `SELECT id FROM transactions WHERE account_id = ?`, account).length;
const checkpoints = (account: string) =>
  queryAll<{ bank_balance: number }>(
    db, `SELECT bank_balance FROM reconciliations WHERE account_id = ? ORDER BY created_at`, account,
  );

test("a card's reconcile form asks how much the statement says you owe, with an in-credit tick", async () => {
  const body = await (await app.get(`/accounts/${card}/reconcile`)).text();
  assert.match(body, /How much does the statement say you owe\?/);
  assert.match(body, /name="in_credit"/);
  assert.match(body, /you owe ₹10,000/);
  assert.doesNotMatch(body, /What does the bank say\?/);
});

test("typing 10,000 against a card at −₹10,000 shows no gap and posts no adjustment", async () => {
  const before = txCount(card);
  const res = await app.post(`/accounts/${card}/reconcile`, {
    as_of: "2026-09-01", bank_balance: "10,000",
  });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /Reconciled/);
  assert.doesNotMatch(body, /adjustment/);
  assert.equal(txCount(card), before);
  assert.equal(checkpoints(card).at(-1)!.bank_balance, -rupees(10_000));
  assert.deepEqual(app.failures, []);
});

test("a card in credit: the tick, or the statement's Cr, means the bank owes you", async () => {
  for (const form of [
    { bank_balance: "2,500", in_credit: "1" },
    { bank_balance: "2,500.00 Cr" },
  ]) {
    const res = await app.post(`/accounts/${card}/reconcile`, { as_of: "2026-09-02", ...form });
    const body = await res.text();
    assert.match(body, /₹2,500 in credit/, JSON.stringify(form));
    assert.match(body, /you owe ₹10,000/);
    // The difference page carries the figure back the same way it came in.
    assert.match(body, /name="bank_balance" value="2500.00"/);
    assert.match(body, /type="hidden" name="in_credit" value="1"/);
    assert.match(body, /Add a ₹12,500 adjustment/);
  }
  assert.deepEqual(app.failures, []);
});

test("a minus, brackets or Dr are all still owed — the question already says owe", async () => {
  for (const typed of ["-10,000", "(10,000)", "10,000 Dr"]) {
    const res = await app.post(`/accounts/${card}/reconcile`, {
      as_of: "2026-09-03", bank_balance: typed,
    });
    assert.match(await res.text(), /Reconciled/, typed);
  }
  assert.ok(checkpoints(card).every((c) => c.bank_balance === -rupees(10_000)));
});

test("crore shorthand on a card is still read as crore, owed", async () => {
  const res = await app.post(`/accounts/${card}/reconcile`, { as_of: "2026-09-04", bank_balance: "3Cr" });
  const body = await res.text();
  assert.match(body, /you owe ₹3,00,00,000/);
  assert.doesNotMatch(body, /in credit/);
});

test("a savings account still asks what the bank says and takes the figure as it is", async () => {
  const page = await (await app.get(`/accounts/${savings}/reconcile`)).text();
  assert.match(page, /What does the bank say\?/);
  assert.doesNotMatch(page, /name="in_credit"/);
  const before = txCount(savings);
  const res = await app.post(`/accounts/${savings}/reconcile`, {
    as_of: "2026-09-01", bank_balance: "10,000",
  });
  assert.match(await res.text(), /Reconciled/);
  assert.equal(txCount(savings), before);
  assert.equal(checkpoints(savings).at(-1)!.bank_balance, rupees(10_000));
});
