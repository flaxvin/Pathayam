/**
 * 15 · Another member's private thing answers exactly like a thing that does
 * not exist — by URL, in every list, and in every file the app hands out.
 *
 * An audit signed in as Priya and addressed Ravi's private things by id. Most
 * routes had been taught the rule; a whole second tier had not. As Priya:
 *
 * - `/export.json` carried his private ₹3,00,000 savings account, his envelope,
 *   his therapy-clinic payee and every one of his transactions off the machine;
 * - `/activity/<id>/undo` deleted his ₹60,000 private-card purchase outright;
 * - `/schedules/<id>/edit|paid|skip|delete` renamed, paid (into his private
 *   account), skipped and removed his subscription;
 * - `/goals/<id>/edit|complete|delete` did the same to his goal;
 * - `/portfolio/<id>/split` doubled the 100 units in his private demat to 200;
 * - `/add`, `/schedules/new` and `/portfolio/add` wrote into his private
 *   accounts, while a made-up account id answered 422 — so the difference
 *   between the two answers confirmed which ids were real.
 *
 * Each block below is one of those, and each proves a 404 — never a 403, a 422
 * or a rendered page, all of which confirm that the thing is there.
 *
 * The last block is the broad one: every id-addressed route in the router,
 * pointed at each of Ravi's things, must not answer 200 or 303 — so the next
 * route that forgets the check fails here the day it is written.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp, type TestApp } from "./harness.test-data.ts";
import { queryOne, queryAll, type DB } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { rupees, type Paise } from "../core/money.ts";
import { todayIST, addDays } from "../core/dates.ts";
import { createAccount, createCard } from "../domain/accounts.ts";
import { createGroup, createCategory } from "../domain/budget.ts";
import { createTransaction } from "../domain/transactions.ts";
import { ensurePersonalBudget } from "../domain/budgets.ts";
import { createSchedule } from "../domain/schedules.ts";
import { createGoal } from "../domain/goals.ts";
import {
  createAssetAccount, findOrCreateInstrument, recordPurchase, listHoldings,
} from "../domain/assets.ts";
import { units, price } from "../portfolio/holdings.ts";

const RAVI = "m-ravi";
const PRIYA = "m-priya";
const ravi: Actor = { memberId: RAVI, source: "ui" };

/** Names that exist nowhere else, so a match anywhere is unambiguous. */
const SECRETS = [
  "Zzyzx Private Account", "Qwertyuiop Envelope", "Grimalkin Therapy Clinic",
  "Snorlax Secret Subscription", "Jabberwock Private Goal", "Quokka Private Demat",
  "Bandersnatch Secret Fund", "Wombat Private Card", "Wombat Jeweller",
];

export interface World {
  db: DB;
  ids: {
    account: string; category: string; group: string; budget: string;
    sched: string; goal: string; demat: string; holding: string; instrument: string;
    card: string; cardAccount: string; cardTx: string; cardEvent: string; tx: string;
    household: string; householdCategory: string;
  };
}

/**
 * Ravi's personal budget with one of everything private in it, and a little
 * household money so the screens have something ordinary to show Priya.
 */
export function build(): World {
  const db = freshDb();
  seedMember(db, RAVI, "Ravi");
  seedMember(db, PRIYA, "Priya");
  const today = todayIST();

  const household = createAccount(db, ravi, {
    name: "Joint current", kind: "budget", subtype: "savings",
    openingDate: "2025-01-01", openingBalance: rupees(50_000) as Paise,
  });
  const everyday = createGroup(db, ravi, "Everyday");
  const groceries = createCategory(db, ravi, { groupId: everyday.id, name: "Groceries" });

  const his = ensurePersonalBudget(db, RAVI, "Ravi");
  const account = createAccount(db, ravi, {
    name: "Zzyzx Private Account", kind: "budget", subtype: "savings",
    openingDate: "2025-01-01", openingBalance: rupees(3_00_000) as Paise,
    holderMemberId: RAVI, visibility: "private", budgetId: his.id,
  });
  const group = createGroup(db, ravi, "Mine", "normal", his.id);
  const category = createCategory(db, ravi, { groupId: group.id, name: "Qwertyuiop Envelope" });
  let tx = "";
  for (let i = 1; i <= 4; i++) {
    tx = createTransaction(db, ravi, {
      accountId: account.id, amount: -rupees(999) as Paise, date: addDays(today, -30 * i),
      categoryId: category.id, payeeName: "Grimalkin Therapy Clinic", cleared: true,
      ownerMemberId: RAVI,
    }).id;
  }
  const sched = createSchedule(db, ravi, {
    name: "Snorlax Secret Subscription", accountId: account.id, categoryId: category.id,
    amount: -rupees(777) as Paise, recurrence: "monthly", nextDue: addDays(today, 3),
    isSubscription: true,
  });
  const goal = createGoal(db, ravi, {
    name: "Jabberwock Private Goal", targetAmount: rupees(50_000) as Paise, budgetId: his.id,
  });
  const demat = createAssetAccount(db, ravi, {
    name: "Quokka Private Demat", subtype: "investment", holderMemberId: RAVI,
    visibility: "private",
  });
  const fund = findOrCreateInstrument(db, ravi, { name: "Bandersnatch Secret Fund", kind: "mutual-fund" });
  recordPurchase(db, ravi, {
    accountId: demat.id, instrumentId: fund.id, tradeDate: addDays(today, -10),
    price: price(80), units: units(100),
  });
  const holding = listHoldings(db, demat.id)[0]!;

  const cc = createAccount(db, ravi, {
    name: "Wombat Private Card", kind: "credit", subtype: "credit-card",
    openingDate: "2025-01-01", openingBalance: 0 as Paise, holderMemberId: RAVI,
    visibility: "private", budgetId: his.id,
  });
  const card = createCard(db, ravi, { accountId: cc.id, label: "Add-on", last4: "4242", holderMemberId: RAVI });
  const cardTx = createTransaction(db, ravi, {
    accountId: cc.id, amount: -rupees(60_000) as Paise, date: today, categoryId: category.id,
    payeeName: "Wombat Jeweller", cleared: true, ownerMemberId: RAVI,
  });
  const cardEvent = queryOne<{ id: string }>(
    db, `SELECT id FROM events WHERE entity = 'transaction' AND entity_id = ?`, cardTx.id,
  )!.id;

  return {
    db,
    ids: {
      account: account.id, category: category.id, group: group.id, budget: his.id,
      sched: sched.id, goal: goal.id, demat: demat.id, holding: holding.id,
      instrument: fund.id, card: card.id, cardAccount: cc.id, cardTx: cardTx.id,
      cardEvent, tx, household: household.id, householdCategory: groceries.id,
    },
  };
}

/** As Priya, against a fresh copy of the world. */
async function asPriya<T>(fn: (app: TestApp, w: World) => Promise<T>): Promise<T> {
  const w = build();
  const app = await startTestApp(w.db, { memberId: PRIYA });
  try {
    const out = await fn(app, w);
    assert.deepEqual(app.failures, [], "a route 500ed");
    return out;
  } finally {
    await app.close();
  }
}

function leaks(body: string): string[] {
  return SECRETS.filter((s) => body.includes(s));
}

describe("15 · undo is as private as the change it undoes", () => {
  test("Priya cannot undo Ravi's private-card purchase — 404, and it stays", async () => {
    await asPriya(async (app, { db, ids }) => {
      const res = await app.post(`/activity/${ids.cardEvent}/undo`, {});
      assert.equal(res.status, 404);
      const row = queryOne<{ deleted_at: string | null }>(
        db, `SELECT deleted_at FROM transactions WHERE id = ?`, ids.cardTx,
      );
      assert.ok(row, "the ₹60,000 purchase was deleted by somebody who cannot see it");
      assert.equal(row.deleted_at, null);
    });
  });

  test("and an event that never existed answers the same", async () => {
    await asPriya(async (app) => {
      assert.equal((await app.post(`/activity/no-such-event/undo`, {})).status, 404);
    });
  });

  test("Ravi can still undo his own", async () => {
    const w = build();
    const app = await startTestApp(w.db, { memberId: RAVI });
    try {
      const res = await app.post(`/activity/${w.ids.cardEvent}/undo`, {});
      assert.equal(res.status, 303);
    } finally {
      await app.close();
    }
  });
});

describe("15 · the activity log names nothing of Ravi's", () => {
  test("goals, schedules, demat accounts and instruments are hidden, not just accounts", async () => {
    await asPriya(async (app) => {
      const body = await (await app.get("/activity")).text();
      assert.deepEqual(leaks(body), []);
    });
  });

  test("a deleted private schedule stays private in the log", async () => {
    const w = build();
    const his = await startTestApp(w.db, { memberId: RAVI });
    assert.equal((await his.post(`/schedules/${w.ids.sched}/delete`, {})).status, 303);
    await his.close();
    const app = await startTestApp(w.db, { memberId: PRIYA });
    try {
      assert.deepEqual(leaks(await (await app.get("/activity")).text()), []);
    } finally {
      await app.close();
    }
  });

  test("Ravi still reads his own", async () => {
    const w = build();
    const app = await startTestApp(w.db, { memberId: RAVI });
    try {
      const body = await (await app.get("/activity")).text();
      for (const s of ["Jabberwock Private Goal", "Snorlax Secret Subscription", "Quokka Private Demat"]) {
        assert.ok(body.includes(s), `Ravi's log lost ${s}`);
      }
    } finally {
      await app.close();
    }
  });
});
