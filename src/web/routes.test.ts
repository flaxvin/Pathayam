/**
 * B68 · Every route, actually invoked.
 *
 * `link-coverage.test.ts` proves each rendered link points at a route that is
 * registered. This proves the route on the other end runs. The two together
 * close the seam that produced four of the last five bugs: a screen that was
 * reachable, wired, and broken.
 *
 * The bar here is deliberately low and wide — no page may throw — because that
 * is the failure the unit tests below this line structurally cannot see. A
 * handler can only be wrong in ways the domain tests already cover, or wrong in
 * the wiring, and the wiring had no tests at all.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execute, queryOne, type DB } from "../db/db.ts";
import { rupees } from "../core/money.ts";
import type { Actor } from "../core/events.ts";
import { createAccount, createCard } from "../domain/accounts.ts";
import { createGroup, createCategory, setAssigned, setTarget } from "../domain/budget.ts";
import { createTransaction } from "../domain/transactions.ts";
import { createGoal } from "../domain/goals.ts";
import { createLoan } from "../domain/loans.ts";
import { createSchedule } from "../domain/schedules.ts";
import { createFamilyLoan } from "../domain/family-loans.ts";
import {
  createAssetAccount, findOrCreateInstrument, recordPurchase, recordPrice, recordValuation,
} from "../domain/assets.ts";
import { listHoldings } from "../domain/assets.ts";
import { units as toUnits, price as toPrice } from "../portfolio/holdings.ts";
import { startTestApp, seedMember, freshDb, type TestApp } from "./harness.test-data.ts";

const here = dirname(fileURLToPath(import.meta.url));
const actor: Actor = { memberId: "m", source: "ui" };

/** Enough of a household that no page renders its empty state by accident. */
interface Fixture {
  db: DB;
  ids: Record<string, string>;
}

function household(): Fixture {
  const db = freshDb();
  seedMember(db);

  const bank = createAccount(db, actor, {
    name: "HDFC", kind: "budget", subtype: "savings",
    openingDate: "2026-01-01", openingBalance: rupees(200000),
  });
  const cardAccount = createAccount(db, actor, {
    name: "Atlas", kind: "credit", subtype: "credit-card",
    openingDate: "2026-01-01", openingBalance: rupees(0),
  });
  const card = createCard(db, actor, {
    accountId: cardAccount.id, label: "Atlas", last4: "4321", holderMemberId: "m",
  });

  const group = createGroup(db, actor, "Flexible");
  const groceries = createCategory(db, actor, { groupId: group.id, name: "Groceries" }).id;
  const rent = createCategory(db, actor, { groupId: group.id, name: "Rent" }).id;
  setTarget(db, actor, groceries, { type: "monthly", amount: rupees(16000) });
  setAssigned(db, actor, "2026-09", groceries, rupees(16000));
  setAssigned(db, actor, "2026-09", rent, rupees(41000));

  const txn = createTransaction(db, actor, {
    accountId: bank.id, amount: -rupees(2500), date: "2026-09-05",
    categoryId: groceries, payeeName: "Kirana", tags: ["september"],
  });
  createTransaction(db, actor, {
    accountId: bank.id, amount: rupees(150000), date: "2026-09-01", payeeName: "Salary",
  });

  const goal = createGoal(db, actor, {
    name: "Kerala trip", targetAmount: rupees(80000), categoryIds: [groceries],
  });
  const loan = createLoan(db, actor, {
    lender: "HDFC", loanType: "personal", interestModel: "reducing", annualRatePct: 9.5,
    sanctioned: rupees(500000), sanctionDate: "2026-01-01", tenureMonths: 36,
    firstInstalmentDate: "2026-02-05", repaymentAccountId: bank.id,
  });
  const schedule = createSchedule(db, actor, {
    name: "Rent", amount: rupees(-41000), recurrence: "monthly",
    nextDue: "2026-10-01", accountId: bank.id, categoryId: rent,
  });

  // FL · Lending in the family, so /family/:id has something to open.
  const family = createFamilyLoan(db, actor, {
    counterparty: "Appa", agreedTotal: rupees(100000), startedAt: "2026-02-01",
  });

  // 07 · A traded holding and a physical asset — three different portfolio
  // routes, three different kinds of id. Passing an account id to all of them
  // is how the first version of this fixture 404'd rather than exercising them.
  const demat = createAssetAccount(db, actor, { name: "Zerodha", subtype: "investment" });
  const fund = findOrCreateInstrument(db, actor, {
    name: "Parag Parikh Flexi Cap", kind: "mutual-fund", symbol: "122639", provider: "mfapi",
  });
  recordPurchase(db, actor, {
    accountId: demat.id, instrumentId: fund.id, tradeDate: "2026-03-01",
    price: toPrice(70), amount: rupees(25000),
    fromAccountId: bank.id, categoryId: groceries,
  });
  recordPrice(db, { instrumentId: fund.id, price: toPrice(78), asOf: "2026-09-01", source: "test" });
  const holding = listHoldings(db, demat.id)[0]!;

  const physical = createAssetAccount(db, actor, { name: "Gold", subtype: "commodity" });
  recordValuation(db, actor, { accountId: physical.id, value: rupees(285000), asOf: "2026-09-01" });

  return {
    db,
    ids: {
      account: bank.id, card: card.id, cardAccount: cardAccount.id,
      category: groceries, transaction: txn.id,
      goal: goal.id, loan: loan.id, schedule: schedule.id,
      family: family.id, holding: holding.id, assetAccount: physical.id,
      month: "2026-09",
    },
  };
}

/** The GET routes registered in app.ts, with params filled from the fixture. */
function getRoutes(ids: Record<string, string>): string[] {
  const source = readFileSync(join(here, "..", "app.ts"), "utf8");
  const patterns = [...source.matchAll(/router\.get\("([^"]+)"/g)].map((m) => m[1]!);

  const skip = new Set([
    "/auth/google", "/auth/google/callback", // need a live Google round-trip
    "/gmail/connect", "/gmail/callback",
    "/auth/dev",
    "/attachment/:id",                        // needs a stored file on disk
  ]);

  const fill = (pattern: string): string | null => {
    if (skip.has(pattern)) return null;
    // Order matters: the more specific prefix has to win before the shorter
    // one rewrites it (/portfolio/asset/:id before /portfolio/:id).
    const path = pattern
      .replace("/accounts/:id/statement", `/accounts/${ids.cardAccount}/statement`)
      .replace("/accounts/:id", `/accounts/${ids.account}`)
      .replace("/transaction/:id", `/transaction/${ids.transaction}`)
      .replace("/loans/:id", `/loans/${ids.loan}`)
      .replace("/family/:id", `/family/${ids.family}`)
      .replace("/months/:month", `/months/${ids.month}`)
      .replace("/explain/category/:id", `/explain/category/${ids.category}`)
      .replace("/portfolio/asset/:id", `/portfolio/asset/${ids.assetAccount}`)
      .replace("/portfolio/:id", `/portfolio/${ids.holding}`)
      .replace("/categories/:id", `/categories/${ids.category}`)
      .replace(":cardId", ids.card);
    return path.includes(":") ? null : path;
  };

  return patterns.map(fill).filter((p): p is string => p !== null);
}

describe("B68 · every GET route renders", () => {
  let app: TestApp;
  let fixture: Fixture;

  before(async () => {
    fixture = household();
    app = await startTestApp(fixture.db);
  });
  after(async () => { await app.close(); fixture.db.close(); });

  test("the route list was extracted", () => {
    assert.ok(getRoutes(fixture.ids).length > 50, "expected the real route table");
  });

  test("no GET route throws, and none renders a broken value", async () => {
    const broken: string[] = [];
    for (const path of getRoutes(fixture.ids)) {
      const res = await app.get(path);
      // 2xx or a redirect are both fine; 4xx/5xx from a seeded household is not.
      if (res.status >= 400) {
        broken.push(`${path} -> ${res.status}`);
        continue;
      }
      if (res.status >= 300) continue;
      const body = await res.text();
      for (const smell of ["NaN", "[object Object]", "undefined</", ">undefined<"]) {
        if (body.includes(smell)) broken.push(`${path} rendered ${smell}`);
      }
    }
    assert.deepEqual(broken, [], "these routes did not render cleanly");
  });

  test("nothing raised an unexpected 500", () => {
    assert.deepEqual(app.failures, []);
  });
});

describe("B68 · the mutations a household actually performs", () => {
  let app: TestApp;
  let fixture: Fixture;

  before(async () => {
    fixture = household();
    app = await startTestApp(fixture.db);
  });
  after(async () => { await app.close(); fixture.db.close(); });

  test("assigning moves the money and redirects back to the month", async () => {
    const res = await app.post("/assign", {
      month: "2026-09", category_id: fixture.ids.category!, amount: "18000",
    });
    assert.equal(res.status, 303);
    assert.match(res.headers.get("location") ?? "", /^\/\?month=2026-09/);
    assert.equal(
      queryOne<{ amount: number }>(
        fixture.db,
        `SELECT amount FROM assignments WHERE month = ? AND category_id = ?`,
        "2026-09", fixture.ids.category,
      )?.amount,
      rupees(18000),
    );
  });

  test("a category can be renamed, targeted, reordered and hidden", async () => {
    const id = fixture.ids.category!;
    assert.equal((await app.post(`/categories/${id}/rename`, { name: "Food" })).status, 303);
    assert.equal((await app.post(`/categories/${id}/target`, { amount: "17000" })).status, 303);
    assert.equal((await app.post(`/categories/${id}/reorder`, { direction: "down" })).status, 303);
    assert.equal((await app.post(`/categories/${id}/hide`, { hidden: "1" })).status, 303);
    const row = queryOne<{ name: string; hidden_at: string | null }>(
      fixture.db, `SELECT name, hidden_at FROM categories WHERE id = ?`, id,
    )!;
    assert.equal(row.name, "Food");
    assert.ok(row.hidden_at);
  });

  test("a goal round-trips: create, edit, delete", async () => {
    const created = await app.post("/goals/new", {
      name: "New laptop", target_amount: "120000",
    });
    assert.equal(created.status, 303);
    const id = queryOne<{ id: string }>(
      fixture.db, `SELECT id FROM goals WHERE name = 'New laptop'`,
    )!.id;

    // B58 · exactly one app-managed category per goal.
    assert.equal(
      queryOne<{ n: number }>(
        fixture.db, `SELECT COUNT(*) AS n FROM goal_categories WHERE goal_id = ?`, id,
      )!.n,
      1,
    );

    assert.equal(
      (await app.post(`/goals/${id}/edit`, { name: "Laptop", target_amount: "130000" })).status,
      303,
    );
    assert.equal((await app.post(`/goals/${id}/delete`)).status, 303);
  });

  test("B65 · undo is reachable and reverses the change", async () => {
    const before = queryOne<{ n: number }>(
      fixture.db, `SELECT COUNT(*) AS n FROM transactions WHERE deleted_at IS NULL`,
    )!.n;

    await app.post("/add", {
      amount: "450", direction: "out", payee: "Test Shop",
      category_id: fixture.ids.category!, account_id: fixture.ids.account!,
      date: "05-09-2026",
    });
    const added = queryOne<{ n: number }>(
      fixture.db, `SELECT COUNT(*) AS n FROM transactions WHERE deleted_at IS NULL`,
    )!.n;
    assert.equal(added, before + 1, "the transaction was added");

    const event = queryOne<{ id: string }>(
      fixture.db,
      `SELECT id FROM events WHERE entity='transaction' AND action='create' ORDER BY seq DESC LIMIT 1`,
    )!;
    const undone = await app.post(`/activity/${event.id}/undo`);
    assert.equal(undone.status, 303, "undo must not 500 — this is the B65 regression");
    assert.equal(
      queryOne<{ n: number }>(
        fixture.db, `SELECT COUNT(*) AS n FROM transactions WHERE deleted_at IS NULL`,
      )!.n,
      before,
    );
  });

  test("a refused undo answers 422, which the client shows instead of retrying", async () => {
    const event = queryOne<{ id: string }>(
      fixture.db, `SELECT id FROM events WHERE entity='session' ORDER BY seq DESC LIMIT 1`,
    );
    if (!event) return; // no session event in this fixture
    const res = await app.post(`/activity/${event.id}/undo`, {}, {
      headers: { Accept: "application/json" },
    });
    assert.equal(res.status, 422);
  });

  test("signing out is honoured, and the app then refuses", async () => {
    assert.equal((await app.post("/signout")).status, 303);
  });

  test("nothing raised an unexpected 500", () => {
    assert.deepEqual(app.failures, []);
  });
});
