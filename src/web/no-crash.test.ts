/**
 * Nothing a household can type should reach them as "Something went wrong".
 *
 * The app has three kinds of answer: a `Refusal` (422) or `Missing` (404) is
 * the domain saying no on purpose and explaining why; an `HttpError` carries
 * its own status; and anything else thrown is a 500 — a fault. For a long time
 * a great many deliberate refusals were thrown as plain `Error`, so a bad
 * amount, a category that still held money, or a mistyped id in a URL all
 * arrived as *"Something went wrong on the server"* with the sentence that
 * explained the problem thrown away.
 *
 * It was worse than rude. An unexpected throw is recorded as a genuine defect,
 * and that is not hypothetical here: one request carrying a mistyped account id
 * once put a failed check on the health page, the health check reported the
 * instance unhealthy, the platform stopped routing to it, and the public demo
 * was down for twenty-four hours. Somebody guessing a URL must not be able to
 * do that.
 *
 * So: every POST route, with a body it was not expecting, and a handful of
 * routes addressed with ids that do not exist. A 500 from any of them fails.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { freshDb, seedMember, startTestApp, testConfig, type TestApp } from "./harness.test-data.ts";
import { createAccount } from "../domain/accounts.ts";
import { createGroup, createCategory } from "../domain/budget.ts";
import { createTransaction } from "../domain/transactions.ts";
import { createSchedule } from "../domain/schedules.ts";
import { rupees, type Paise } from "../core/money.ts";
import type { IsoDate } from "../core/dates.ts";

const actor = { memberId: "m-ravi", source: "ui" as const };

/** Every POST the router registers, read from the source so it cannot drift. */
function postRoutes(): string[] {
  const src = readFileSync("src/app.ts", "utf8");
  return [...new Set(
    [...src.matchAll(/router\.post\("([^"]+)"/g)].map((m) => m[1]!),
  )].sort();
}

/*
 * Several bodies, not one, because they reach different depths. A body whose
 * amount is not a number is refused while the amount is being read, and never
 * touches the rule underneath it — so "0" and "-0" are here to get past the
 * parser and reach the domain checks that a single nonsense body leaves
 * untested. Dropping any of these makes this file quietly weaker.
 */
const BODIES: [string, Record<string, string>][] = [
  ["empty", {}],
  ["unreadable", {
    amount: "not-a-number", date: "31-02-2026", month: "2026-13", name: "",
    category_id: "no-such-id", account_id: "no-such-id",
    recurrence: "fortnighly", direction: "sideways",
    remap_to: "no-such-id", type: "not-a-target-type",
  }],
  ["readable but refused", {
    amount: "-0", date: "2026-09-05", month: "2026-09", name: "x",
    type: "monthly", direction: "out", recurrence: "monthly",
  }],
  ["zero and empty strings", {
    amount: "0", date: "", month: "", name: "", category_id: "", account_id: "",
    recurrence: "", direction: "", type: "",
  }],
];

let app: TestApp;
let ids: { bank: string; card: string; cat: string; group: string; tx: string; sch: string };

before(async () => {
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
  const group = createGroup(db, actor, "Home").id;
  const cat = createCategory(db, actor, { groupId: group, name: "Rent" }).id;
  const tx = createTransaction(db, actor, {
    accountId: bank, amount: -rupees(500) as Paise, date: "2026-09-05", categoryId: cat,
  }).id;
  const sch = createSchedule(db, actor, {
    name: "S", accountId: bank, categoryId: cat, amount: -rupees(1_000) as Paise,
    recurrence: "monthly", nextDue: "2026-10-05" as IsoDate,
  }).id;
  ids = { bank, card, cat, group, tx, sch };
  app = await startTestApp(db, { memberId: "m-ravi", config: testConfig({}) });
});

after(async () => { await app.close(); });

function fill(route: string): string {
  return route
    .replace("/transaction/:id", `/transaction/${ids.tx}`)
    .replace("/schedules/:id", `/schedules/${ids.sch}`)
    .replace("/accounts/:id", `/accounts/${ids.bank}`)
    .replace("/categories/:id", `/categories/${ids.cat}`)
    .replace("/groups/:id", `/groups/${ids.group}`)
    .replace(/:id/g, ids.bank)
    .replace(/:[a-zA-Z]+/g, "x");
}

describe("no POST answers a bad body with a crash", () => {
  test("every route, given each kind of bad body", async () => {
    const crashes: string[] = [];
    const routes = postRoutes()
      // Sign-in, Gmail and restore reach outward or replace the database.
      .filter((r) => !/\/auth\/|\/gmail|\/signout|\/restore|\/backup/.test(r));
    assert.ok(routes.length > 100, `only ${routes.length} routes found — the scan is broken`);

    for (const [label, body] of BODIES) {
      for (const route of routes) {
        const res = await app.post(fill(route), body);
        if (res.status >= 500) crashes.push(`[${label}] ${route} -> ${res.status}`);
      }
    }
    assert.deepEqual(
      crashes, [],
      "a malformed body reached the household as 'Something went wrong', and was " +
      "recorded as a defect — see the header of this file for why that matters",
    );
  });

  test("and the app recorded no faults while being poked", () => {
    const unexpected = app.failures.map((f) => `${f.method} ${f.path}: ${f.error.split("\n")[0]}`);
    assert.deepEqual(unexpected, [], "an unexpected throw was recorded as a genuine defect");
  });
});

describe("an id that names nothing is a 404, not a fault", () => {
  const GONE = "11111111-2222-3333-4444-555555555555";

  /*
   * These seven answered 500 until `Missing` existed. They are the ones a URL
   * can address directly, so they are the ones somebody can reach by editing an
   * address bar or following a stale link.
   */
  for (const [label, path] of [
    ["a goal being completed", `/goals/${GONE}/complete`],
    ["a goal being deleted", `/goals/${GONE}/delete`],
    ["a token being revoked", `/tokens/${GONE}/revoke`],
    ["an instrument being classified", `/portfolio/instrument/${GONE}/classify`],
    ["a schedule marked paid", `/schedules/${GONE}/paid`],
    ["a schedule occurrence skipped", `/schedules/${GONE}/skip`],
    ["a transaction being edited", `/transaction/${GONE}`],
    ["a category being deleted", `/categories/${GONE}/delete`],
  ] as const) {
    test(label, async () => {
      const res = await app.post(path, {});
      assert.equal(res.status, 404, `${path} answered ${res.status}`);
    });
  }

  test("a card that is not on the account", async () => {
    const res = await app.post(`/accounts/${ids.card}/cards/${GONE}/close`, {});
    assert.equal(res.status, 404);
  });
});
