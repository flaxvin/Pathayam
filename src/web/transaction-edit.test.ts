/**
 * F4.3 · The transaction screen edits the whole record.
 *
 * The form once knew nothing of splits, tags or ownership: a split
 * transaction rendered as "Uncategorised", and pressing Save silently
 * deleted its lines, because the handler always passed a categoryId and
 * the domain treats a category with no splits as an unsplit. These tests
 * pin the repaired contract: what the screen shows is what the record is,
 * and what survives a save is what the reader believes they saved.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { queryOne } from "../db/db.ts";
import { rupees } from "../core/money.ts";
import type { Actor } from "../core/events.ts";
import type { DB } from "../db/db.ts";
import { createAccount } from "../domain/accounts.ts";
import { createGroup, createCategory } from "../domain/budget.ts";
import {
  createTransaction, getTransaction, getSplits, tagsFor, updateTransaction,
} from "../domain/transactions.ts";
import { startTestApp, seedMember, freshDb, type TestApp } from "./harness.test-data.ts";
import { createCard, paymentCategoryFor } from "../domain/accounts.ts";

const actor: Actor = { memberId: "m", source: "ui" };

let db: DB;
let app: TestApp;
let bank: string;
let groceries: string;
let eatingOut: string;

before(async () => {
  db = freshDb();
  seedMember(db);
  seedMember(db, "m2", "Priya");
  bank = createAccount(db, actor, {
    name: "HDFC", kind: "budget", subtype: "savings",
    openingDate: "2026-01-01", openingBalance: rupees(100000),
  }).id;
  const group = createGroup(db, actor, "Flexible");
  groceries = createCategory(db, actor, { groupId: group.id, name: "Groceries" }).id;
  eatingOut = createCategory(db, actor, { groupId: group.id, name: "Eating out" }).id;
  app = await startTestApp(db);
});
after(async () => {
  await app.close();
});

function spend(amount: number): string {
  return createTransaction(db, actor, {
    accountId: bank, amount: -rupees(amount) as ReturnType<typeof rupees>,
    date: "2026-09-05", categoryId: groceries, payeeName: "DMart",
  }).id;
}

function splitSpend(): string {
  return createTransaction(db, actor, {
    accountId: bank, amount: -rupees(3000), date: "2026-09-06", payeeName: "DMart",
    splits: [
      { categoryId: groceries, amount: -rupees(2000) },
      { categoryId: eatingOut, amount: -rupees(1000) },
    ],
  }).id;
}

const base = {
  amount: "3000", direction: "out", date: "06-09-2026", payee: "DMart",
  memo: "", tags: "", owner_member_id: "", category_id: "",
};

describe("F4.3 · a split transaction survives its own edit screen", () => {
  test("the screen shows the split lines", async () => {
    const id = splitSpend();
    const page = await app.get(`/transaction/${id}`);
    assert.equal(page.status, 200);
    const body = await page.text();
    assert.match(body, /Split across 2 envelopes/);
    assert.match(body, /2000\.00/);
    assert.match(body, /1000\.00/);
  });

  test("saving without touching the split keeps it", async () => {
    const id = splitSpend();
    const res = await app.post(`/transaction/${id}`, { ...base, memo: "weekly shop" });
    assert.equal(res.status, 303);
    assert.equal(getSplits(db, id).length, 2);
    assert.equal(getTransaction(db, id)!.memo, "weekly shop");
  });

  test("changing the amount without re-splitting is refused", async () => {
    const id = splitSpend();
    const res = await app.post(`/transaction/${id}`, { ...base, amount: "3500" });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /no longer add up/);
    assert.equal(getSplits(db, id).length, 2);
    assert.equal(getTransaction(db, id)!.amount, -rupees(3000));
  });

  test("editing the lines re-splits, and they must sum", async () => {
    const id = splitSpend();
    const ok = await app.post(`/transaction/${id}`, {
      ...base, amount: "3500",
      split_category_0: groceries, split_amount_0: "2500",
      split_category_1: eatingOut, split_amount_1: "1000",
    });
    assert.equal(ok.status, 303);
    const lines = getSplits(db, id);
    assert.equal(lines.length, 2);
    assert.equal(lines.reduce((s, l) => s + l.amount, 0), -rupees(3500));

    const short = await app.post(`/transaction/${id}`, {
      ...base, amount: "3500",
      split_category_0: groceries, split_amount_0: "100",
      split_category_1: eatingOut, split_amount_1: "100",
    });
    assert.equal(short.status, 400);
  });

  test("filing to one envelope is an explicit choice, and works", async () => {
    const id = splitSpend();
    const res = await app.post(`/transaction/${id}`, { ...base, category_id: groceries });
    assert.equal(res.status, 303);
    assert.equal(getSplits(db, id).length, 0);
    const t = getTransaction(db, id)!;
    assert.equal(t.is_split, 0);
    assert.equal(t.category_id, groceries);
  });

  test("a plain transaction can be split from the screen", async () => {
    const id = spend(1800);
    const res = await app.post(`/transaction/${id}`, {
      ...base, amount: "1800",
      split_category_0: groceries, split_amount_0: "1300",
      split_category_1: eatingOut, split_amount_1: "500",
    });
    assert.equal(res.status, 303);
    assert.equal(getSplits(db, id).length, 2);
    assert.equal(getTransaction(db, id)!.is_split, 1);
  });

  test("one filled line collapses into that envelope", async () => {
    /*
     * Reversed deliberately. This used to be a 400 pointing at the category
     * field — which the split had disabled, so there was no way back to a
     * single envelope short of clearing every line and remembering to set the
     * category in the same save. One line is that envelope.
     */
    const id = spend(900);
    const res = await app.post(`/transaction/${id}`, {
      ...base, amount: "900",
      split_category_0: groceries, split_amount_0: "900",
    });
    assert.equal(res.status, 303);
    const after = queryOne<{ category_id: string; is_split: number }>(
      db, `SELECT category_id, is_split FROM transactions WHERE id = ?`, id,
    )!;
    assert.equal(after.category_id, groceries);
    assert.equal(after.is_split, 0, "it still claims to be split");
  });

  test("but one line short of the amount is still refused", async () => {
    const id = spend(900);
    const res = await app.post(`/transaction/${id}`, {
      ...base, amount: "900",
      split_category_0: groceries, split_amount_0: "400",
    });
    assert.equal(res.status, 400, "₹400 was accepted as the whole of ₹900");
  });
});

describe("R6 · a payment envelope cannot be filed to directly", () => {
  test("the edit form refuses it with the reason, and changes nothing", async () => {
    const cardAccount = createAccount(db, actor, {
      name: "Atlas", kind: "credit", subtype: "credit-card",
      openingDate: "2026-01-01", openingBalance: rupees(0),
    });
    createCard(db, actor, {
      accountId: cardAccount.id, label: "Atlas", last4: "0001", holderMemberId: "m",
    });
    const payment = paymentCategoryFor(db, cardAccount.id)!.id;
    const id = spend(400);
    const res = await app.post(`/transaction/${id}`, {
      ...base, amount: "400", category_id: payment,
    });
    assert.equal(res.status, 422);
    assert.match(await res.text(), /payment envelope/);
    assert.equal(getTransaction(db, id)!.category_id, groceries);

    const asSplit = await app.post(`/transaction/${id}`, {
      ...base, amount: "400",
      split_category_0: groceries, split_amount_0: "100",
      split_category_1: payment, split_amount_1: "300",
    });
    assert.equal(asSplit.status, 422);
    assert.equal(getTransaction(db, id)!.is_split, 0);
  });
});

describe("F4 · a transaction has to move some money", () => {
  test("zero is refused on the way in", async () => {
    const res = await app.post("/add", {
      direction: "out", account_id: bank, amount: "0", date: "05-09-2026",
      payee: "Nobody", category_id: groceries, memo: "",
    });
    assert.equal(res.status, 422);
    assert.match(await res.text(), /move some money/);
  });

  test("and on the way through an edit", async () => {
    const id = spend(300);
    const res = await app.post(`/transaction/${id}`, {
      ...base, amount: "0", category_id: groceries,
    });
    assert.equal(res.status, 422);
    assert.equal(getTransaction(db, id)!.amount, -rupees(300));
  });

  test("a zero transfer is refused too", async () => {
    const other = createAccount(db, actor, {
      name: "Kotak", kind: "budget", subtype: "savings",
      openingDate: "2026-01-01", openingBalance: rupees(1000),
    }).id;
    const res = await app.post("/transfer", {
      from_account_id: bank, to_account_id: other, amount: "0", date: "05-09-2026", memo: "",
    });
    assert.equal(res.status, 422);
  });
});

describe("F4.9 · tags and ownership are editable where the record is", () => {
  test("tags round-trip through the form", async () => {
    const id = spend(700);
    updateTransaction(db, actor, id, { tags: ["old-tag"] });
    const res = await app.post(`/transaction/${id}`, {
      ...base, amount: "700", category_id: groceries, tags: "trip-2026, shared",
    });
    assert.equal(res.status, 303);
    assert.deepEqual(tagsFor(db, id).sort(), ["shared", "trip-2026"]);
  });

  test("a POST that never mentions tags leaves them alone", async () => {
    const id = spend(650);
    updateTransaction(db, actor, id, { tags: ["keep-me"] });
    const { tags: _omit, ...withoutTags } = base;
    const res = await app.post(`/transaction/${id}`, {
      ...withoutTags, amount: "650", category_id: groceries,
    });
    assert.equal(res.status, 303);
    assert.deepEqual(tagsFor(db, id), ["keep-me"]);
  });

  test("whose spending it is can be corrected after the fact", async () => {
    const id = spend(1200);
    const res = await app.post(`/transaction/${id}`, {
      ...base, amount: "1200", category_id: groceries, owner_member_id: "m2",
    });
    assert.equal(res.status, 303);
    assert.equal(getTransaction(db, id)!.owner_member_id, "m2");

    const back = await app.post(`/transaction/${id}`, {
      ...base, amount: "1200", category_id: groceries, owner_member_id: "",
    });
    assert.equal(back.status, 303);
    assert.equal(getTransaction(db, id)!.owner_member_id, null);
  });

  test("the screen carries payee, tags and owner fields", async () => {
    const id = spend(500);
    const page = await app.get(`/transaction/${id}`);
    const body = await page.text();
    assert.match(body, /name="payee"/);
    assert.match(body, /name="tags"/);
    assert.match(body, /name="owner_member_id"/);
    assert.match(body, /name="split_category_0"/);
  });
});
