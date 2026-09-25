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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { freshDb, seedMember, startTestApp, type TestApp } from "./harness.test-data.ts";
import { queryOne, queryAll, execute, type DB } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { rupees, type Paise } from "../core/money.ts";
import { todayIST, addDays, nowIST } from "../core/dates.ts";
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
import { exportEverything } from "../ops/backup.ts";
import { assetAllocation } from "../domain/networth.ts";

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
    household: string; householdCategory: string; rule: string; profile: string;
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
  // A rule that files into his envelope, and an import profile for his account.
  execute(db,
    `INSERT INTO rules (id, name, stage, conditions_json, actions_json, enabled, proposed, created_at)
     VALUES ('rule-his', 'Grimalkin Therapy Clinic to Qwertyuiop Envelope', 'default', ?, ?, 1, 0, ?)`,
    JSON.stringify([{ field: "narration", op: "contains", value: "Grimalkin" }]),
    JSON.stringify([{ type: "setCategory", categoryId: category.id }]), nowIST());
  execute(db,
    `INSERT INTO import_profiles (id, name, account_id, header_signature, mapping_json, created_at)
     VALUES ('profile-his', 'Zzyzx bank format', ?, 'date|amount', '{}', ?)`, account.id, nowIST());

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
      rule: "rule-his", profile: "profile-his",
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

describe("F15 · a member's export is theirs, and the backup stays whole", () => {
  test("/export.json and /export.csv carry nothing of Ravi's", async () => {
    await asPriya(async (app, { ids }) => {
      for (const path of ["/export.json", "/export.csv"]) {
        const body = await (await app.get(path)).text();
        assert.deepEqual(leaks(body), [], `${path} carries Ravi's private things off the machine`);
        for (const id of [ids.account, ids.category, ids.sched, ids.goal, ids.demat, ids.holding]) {
          assert.ok(!body.includes(id), `${path} names one of Ravi's private ids`);
        }
      }
    });
  });

  test("its control totals are over what is in the file, so nothing falls out by subtraction", async () => {
    await asPriya(async (app) => {
      const file = JSON.parse(await (await app.get("/export.json")).text()) as {
        controlTotals: { accountOpeningTotal: number; transactionTotal: number; counts: Record<string, number> };
        data: Record<string, unknown[]>;
      };
      // Only the ₹50,000 joint account; Ravi's ₹3,00,000 is not in the sum.
      assert.equal(file.controlTotals.accountOpeningTotal, rupees(50_000));
      assert.equal(file.controlTotals.transactionTotal, 0);
      assert.equal(file.controlTotals.counts.transactions, file.data.transactions!.length);
    });
  });

  test("Ravi's own export has his, and the operator's backup has everybody's", async () => {
    const w = build();
    const app = await startTestApp(w.db, { memberId: RAVI });
    try {
      const body = await (await app.get("/export.json")).text();
      assert.ok(body.includes("Zzyzx Private Account") && body.includes("Jabberwock Private Goal"));
    } finally {
      await app.close();
    }
    const whole = JSON.stringify(exportEverything(w.db));
    assert.deepEqual(SECRETS.filter((s) => !whole.includes(s)), [], "the backup lost something");
  });
});

/** Run one write as Priya and return its status and whether the row changed. */
async function attempt(
  path: (ids: World["ids"]) => string, form: (ids: World["ids"]) => Record<string, string>,
  probe: (db: DB, ids: World["ids"]) => unknown,
): Promise<{ status: number; changed: boolean }> {
  return asPriya(async (app, { db, ids }) => {
    const before = JSON.stringify(probe(db, ids));
    const res = await app.post(path(ids), form(ids));
    await res.text();
    return { status: res.status, changed: JSON.stringify(probe(db, ids)) !== before };
  });
}

describe("15 · Ravi's schedule, goal, holding and card cannot be touched by URL", () => {
  const cases: [string, (ids: World["ids"]) => string, Record<string, string>, (db: DB, ids: World["ids"]) => unknown][] = [
    ["rename his subscription", (i) => `/schedules/${i.sched}/edit`,
      { name: "Hijacked", amount: "1", direction: "out", next_due: "2026-12-01", recurrence: "monthly" },
      (db, i) => queryOne(db, `SELECT name, amount FROM schedules WHERE id = ?`, i.sched)],
    // Paying it posted ₹777 into his private account as Priya.
    ["pay his subscription", (i) => `/schedules/${i.sched}/paid`, {},
      (db) => queryOne(db, `SELECT COUNT(*) AS n FROM transactions`)],
    ["skip his subscription", (i) => `/schedules/${i.sched}/skip`, {},
      (db, i) => queryOne(db, `SELECT next_due FROM schedules WHERE id = ?`, i.sched)],
    ["delete his subscription", (i) => `/schedules/${i.sched}/delete`, {},
      (db, i) => queryOne(db, `SELECT COUNT(*) AS n FROM schedules WHERE id = ?`, i.sched)],
    ["rename his goal", (i) => `/goals/${i.goal}/edit`, { name: "Hijacked goal", target_amount: "1" },
      (db, i) => queryOne(db, `SELECT name, target_amount FROM goals WHERE id = ?`, i.goal)],
    ["complete his goal", (i) => `/goals/${i.goal}/complete`, { resolution: "release" },
      (db, i) => queryOne(db, `SELECT completed_at FROM goals WHERE id = ?`, i.goal)],
    ["delete his goal", (i) => `/goals/${i.goal}/delete`, {},
      (db, i) => queryOne(db, `SELECT COUNT(*) AS n FROM goals WHERE id = ?`, i.goal)],
    ["price his fund", (i) => `/portfolio/${i.holding}/price`, { price: "12345", as_of: "2026-09-20" },
      (db, i) => queryAll(db, `SELECT price FROM prices WHERE instrument_id = ?`, i.instrument)],
    // 100 units became 200.
    ["split his holding", (i) => `/portfolio/${i.holding}/split`, { ratio: "2", date: "2026-09-20", on: "2026-09-20" },
      (db) => queryAll(db, `SELECT units FROM lots`)],
    ["sell his holding", (i) => `/portfolio/${i.holding}/sell`, { units: "10", price: "90", date: todayIST() },
      (db) => queryAll(db, `SELECT units, closed_at FROM lots`)],
    ["classify his fund", (i) => `/portfolio/instrument/${i.instrument}/classify`, { asset_class: "gold" },
      (db, i) => queryOne(db, `SELECT asset_class FROM instruments WHERE id = ?`, i.instrument)],
    // Through the household's own account, which Priya can see.
    ["close his add-on card", (i) => `/accounts/${i.household}/cards/${i.card}/close`, {},
      (db, i) => queryOne(db, `SELECT closed_at FROM cards WHERE id = ?`, i.card)],
    ["close his add-on card on his account", (i) => `/accounts/${i.cardAccount}/cards/${i.card}/close`, {},
      (db, i) => queryOne(db, `SELECT closed_at FROM cards WHERE id = ?`, i.card)],
    ["convert his ₹60,000 card purchase to an EMI", (i) => `/transaction/${i.cardTx}/convert-to-emi`,
      { tenure_months: "6", annual_rate: "15" }, (db) => queryAll(db, `SELECT id FROM loans`)],
  ];
  for (const [what, path, form, probe] of cases) {
    test(`Priya cannot ${what} — 404, nothing changes`, async () => {
      const { status, changed } = await attempt(path, () => form, probe);
      assert.equal(status, 404);
      assert.equal(changed, false);
    });
  }
});

describe("15 · nothing is written into Ravi's private accounts, and a real id answers like a fake one", () => {
  const today = todayIST();
  const writes: [string, string, (i: World["ids"], account: string) => Record<string, string>, (db: DB, i: World["ids"]) => unknown][] = [
    ["/add", "account", (_i, acc) => ({ account_id: acc, amount: "1", direction: "in", date: today, payee: "Priya was here" }),
      (db, i) => queryOne(db, `SELECT COUNT(*) AS n FROM transactions WHERE account_id = ?`, i.account)],
    ["/schedules/new", "account", (_i, acc) => ({ name: "Priya's schedule", account_id: acc, amount: "1", direction: "in", next_due: today, recurrence: "monthly" }),
      (db, i) => queryOne(db, `SELECT COUNT(*) AS n FROM schedules WHERE account_id = ?`, i.account)],
    ["/portfolio/add", "demat", (_i, acc) => ({ name: "Priya Fund", kind: "mutual-fund", account_id: acc, unit_price: "10", units: "5", trade_date: today }),
      (db, i) => queryOne(db, `SELECT COUNT(*) AS n FROM holdings WHERE account_id = ?`, i.demat)],
    ["/transfer", "account", (i, acc) => ({ from_account_id: i.household, to_account_id: acc, amount: "100", date: today }),
      (db, i) => queryOne(db, `SELECT COUNT(*) AS n FROM transactions WHERE account_id = ?`, i.account)],
    ["/accounts/:id/statement", "cardAccount", () => ({ statement_date: today, due_date: today, amount: "100" }),
      (db) => queryOne(db, `SELECT COUNT(*) AS n FROM card_statements`)],
    ["/accounts/:id/cards", "cardAccount", () => ({ label: "Priya's add-on" }),
      (db) => queryOne(db, `SELECT COUNT(*) AS n FROM cards`)],
    ["/accounts/:id/reconcile", "account", () => ({ as_of: today, bank_balance: "1" }),
      (db) => queryOne(db, `SELECT COUNT(*) AS n FROM reconciliations`)],
  ];
  for (const [route, which, form, probe] of writes) {
    test(`${route} into Ravi's private account is the same 404 as into no account at all`, async () => {
      const at = (i: World["ids"], acc: string) => route.replace(":id", acc);
      const real = await attempt((i) => at(i, i[which as keyof World["ids"]]), (i) => form(i, i[which as keyof World["ids"]]), probe);
      const fake = await attempt((i) => at(i, "no-such-account"), (i) => form(i, "no-such-account"), probe);
      assert.equal(real.changed, false, `${route} wrote into Ravi's private account`);
      assert.equal(real.status, 404);
      assert.equal(fake.status, real.status, "a real private id and a made-up one answer differently");
    });
  }
});

/**
 * The broad one. Every route in the router that takes an id, pointed at each of
 * Ravi's private things in turn, must answer exactly what it answers for an id
 * that does not exist — same status, none of his names in the body, and
 * nothing written. The list of routes is read from app.ts, so a route added
 * tomorrow is checked tomorrow.
 */
describe("15 · every id-addressed route treats Ravi's things as nonexistent", () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "app.ts"), "utf8");
  const routes = [...new Set(
    [...source.matchAll(/router\.(get|post)\(\s*"([^"]*:[^"]*)"/g)].map((m) => `${m[1]} ${m[2]}`),
  )].sort();

  test("there are routes to check", () => {
    assert.ok(routes.length > 60, `only ${routes.length} id-addressed routes found`);
  });

  test("Ravi's ids answer like made-up ones, on all of them", async () => {
    const w = build();
    const app = await startTestApp(w.db, { memberId: PRIYA });
    const today = todayIST();
    // A plausible form, so a route's own validation passes and its id check
    // is what answers — an empty form would 422 for real and fake ids alike.
    const form = {
      name: "Probe", label: "Probe", amount: "1", direction: "out", date: today, on: today,
      next_due: today, recurrence: "monthly", target_amount: "1", price: "10", units: "1",
      ratio: "2", as_of: today, statement_date: today, due_date: today, bank_balance: "1",
      tenure_months: "6", annual_rate: "10", resolution: "release", proceeds: "1", value: "1",
      account_id: w.ids.household, category_id: w.ids.householdCategory, confirm: "1",
    };
    const theirs = Object.entries(w.ids).filter(([k]) => !["household", "householdCategory"].includes(k));
    const seq = () => queryOne<{ n: number }>(w.db, `SELECT COALESCE(MAX(seq), 0) AS n FROM events`)!.n;
    const problems: string[] = [];
    try {
      for (const route of routes) {
        const [method, pattern] = route.split(" ") as ["get" | "post", string];
        const call = (id: string) => {
          const path = pattern.replace(/:[A-Za-z]+/g, id);
          return method === "get" ? app.get(path) : app.post(path, form);
        };
        const fake = await call("00000000-0000-4000-8000-000000000000");
        await fake.text();
        for (const [what, id] of theirs) {
          const before = seq();
          const res = await call(id);
          const body = await res.text();
          if (res.status !== fake.status) problems.push(`${route} with his ${what}: ${res.status}, a made-up id ${fake.status}`);
          const seen = leaks(body);
          if (seen.length) problems.push(`${route} with his ${what} shows ${seen.join(", ")}`);
          if (seq() !== before) problems.push(`${route} with his ${what} wrote something`);
        }
      }
      assert.deepEqual(problems, []);
      assert.deepEqual(app.failures.map((f) => `${f.method} ${f.path}`), []);
    } finally {
      await app.close();
    }
  });
});

describe("15 · the budget page's digest is the reader's", () => {
  test("Priya's digest names none of Ravi's cards, envelopes or subscriptions", async () => {
    await asPriya(async (app) => {
      const body = await (await app.get("/")).text();
      assert.deepEqual(leaks(body), []);
    });
  });

  test("digestFor itself answers for the reader, and Ravi still hears about his own", async () => {
    const w = build();
    const { digestFor } = await import("../domain/digest.ts");
    const hers = digestFor(w.db, PRIYA, todayIST(), PRIYA);
    assert.deepEqual(hers.flatMap((i) => leaks(i.text)), []);
    // Ravi, reading his own budget, still hears about his subscription.
    const his = digestFor(w.db, RAVI, todayIST(), RAVI, w.ids.budget);
    assert.ok(his.some((i) => i.text.includes("Snorlax Secret Subscription")), JSON.stringify(his));
  });
});

describe("15 · the schedules screen lists the household's bills and Priya's", () => {
  test("not Ravi's subscription, nor a suggestion made from his therapy payments", async () => {
    await asPriya(async (app) => {
      for (const path of ["/schedules", "/overview"]) {
        assert.deepEqual(leaks(await (await app.get(path)).text()), [], path);
      }
    });
  });

  test("Ravi's own screen still has both", async () => {
    const w = build();
    const app = await startTestApp(w.db, { memberId: RAVI });
    try {
      const body = await (await app.get(`/schedules?budget=${w.ids.budget}`)).text();
      assert.ok(body.includes("Snorlax Secret Subscription"));
      assert.ok(body.includes("Grimalkin Therapy Clinic"), "the suggestion from his own payments");
    } finally {
      await app.close();
    }
  });
});

/*
 * Deleting a goal hands its envelope back as an ordinary category. The route
 * looked for a "Savings" group among every budget's groups and otherwise
 * created one with no budget — i.e. the household's. So Ravi deleting his
 * personal "Jabberwock Private Goal" moved its envelope into a household
 * group, and Priya's budget page listed it by name.
 */
describe("15 · deleting a personal goal keeps its envelope in that budget", () => {
  test("the envelope's group is Ravi's, and Priya never sees it", async () => {
    const w = build();
    const app = await startTestApp(w.db, { memberId: RAVI });
    try {
      const res = await app.post(`/goals/${w.ids.goal}/delete`, {});
      assert.deepEqual(app.failures, []);
      assert.equal(res.status, 303);
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
    const rows = queryAll<{ name: string; group_budget: string | null }>(w.db,
      `SELECT c.name, g.budget_id AS group_budget FROM categories c
         JOIN category_groups g ON g.id = c.group_id
        WHERE c.name = 'Jabberwock Private Goal'`);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.group_budget, w.ids.budget, "moved into another budget's group");
    const priya = await startTestApp(w.db, { memberId: PRIYA });
    try {
      for (const path of ["/", "/categories"]) {
        const body = await (await priya.get(path)).text();
        assert.ok(!body.includes("Jabberwock Private Goal"), path);
      }
    } finally {
      await priya.close();
    }
  });
});

/*
 * The portfolio page had been taught to hide Ravi's private demat; the pages
 * and files around it had not. As Priya, the allocation counted his 100 units
 * of "Bandersnatch Secret Fund" at ₹80 (₹8,000) into her slices, the CAS form
 * offered "Quokka Private Demat" as a destination, and holdings.csv, lots.csv
 * and prices.csv carried the demat, the fund, its units and its price.
 */
describe("15 · allocation, the CAS picker and the portfolio files are the reader's", () => {
  test("Priya's carry nothing of Ravi's demat", async () => {
    await asPriya(async (app, w) => {
      for (const path of [
        "/portfolio/allocation", "/portfolio/cas",
        "/portfolio/holdings.csv", "/portfolio/lots.csv", "/portfolio/prices.csv",
      ]) {
        const res = await app.get(path);
        assert.equal(res.status, 200, path);
        assert.deepEqual(leaks(await res.text()), [], path);
      }
      const hers = assetAllocation(w.db, todayIST(), "INR", { viewerMemberId: PRIYA });
      assert.equal(hers.total + hers.unclassified.value, 0, "her allocation counts his fund");
    });
  });

  test("Ravi's still have it", async () => {
    const w = build();
    const his = assetAllocation(w.db, todayIST(), "INR", { viewerMemberId: RAVI });
    assert.equal(his.total + his.unclassified.value, rupees(8_000));
    const app = await startTestApp(w.db, { memberId: RAVI });
    try {
      for (const path of ["/portfolio/cas", "/portfolio/holdings.csv", "/portfolio/lots.csv"]) {
        assert.ok((await (await app.get(path)).text()).includes("Quokka Private Demat"), path);
      }
    } finally {
      await app.close();
    }
  });
});
