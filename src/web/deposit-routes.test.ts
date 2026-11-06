/**
 * DEPOSITS · Setting a deposit's terms from the account page and the new
 * account form, and what the valuations screen, net worth and the overview
 * make of them.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { rupees } from "../core/money.ts";
import { todayIST, addDays, formatDate } from "../core/dates.ts";
import type { Actor } from "../core/events.ts";
import { queryOne } from "../db/db.ts";
import { createAccount } from "../domain/accounts.ts";
import { getDepositTerms } from "../domain/deposits.ts";
import { netWorthStatement } from "../domain/networth.ts";
import { fireProjection } from "../domain/fire.ts";
import { freshHousehold, RAVI, PRIYA } from "../engine/identity.test-data.ts";
import { startTestApp } from "./harness.test-data.ts";

const ravi: Actor = { memberId: RAVI, source: "ui" };

function household() {
  const db = freshHousehold();
  const fd = createAccount(db, ravi, {
    name: "Fictional Bank FD", kind: "tracking", subtype: "fixed-deposit",
    openingDate: "2025-01-01", openingBalance: rupees(1_00_000),
  }).id;
  const secret = createAccount(db, ravi, {
    name: "Quokka Private Deposit", kind: "tracking", subtype: "fixed-deposit",
    openingDate: "2025-01-01", openingBalance: rupees(50_000), holderMemberId: RAVI, visibility: "private",
  }).id;
  return { db, fd, secret };
}

const today = todayIST();
const terms = {
  deposit_kind: "fd", deposit_principal: "100000", deposit_rate: "7",
  deposit_start_date: addDays(today, -355), deposit_maturity_date: addDays(today, 10),
  deposit_compounding: "", deposit_payout: "cumulative",
};

describe("DEPOSITS · routes", () => {
  test("terms set on the account page value it; net worth and the pages show the computed figure", async () => {
    const { db, fd } = household();
    const app = await startTestApp(db, { memberId: RAVI });
    try {
      const page = await (await app.get(`/accounts/${fd}`)).text();
      assert.match(page, /action="\/accounts\/[^"]+\/deposit"/);

      const r = await app.post(`/accounts/${fd}/deposit`, terms);
      assert.equal(r.status, 303);
      const saved = getDepositTerms(db, fd)!;
      assert.equal(saved.rateBp, 700);
      assert.equal(saved.compounding, "quarterly", "an FD's own default");

      const worth = netWorthStatement(db).netWorth;
      assert.ok(worth > rupees(1_50_000), `net worth ${worth} counts the interest`);

      const detail = await (await app.get(`/accounts/${fd}`)).text();
      assert.match(detail, /computed from terms/);
      assert.match(detail, /Matures on/);

      const valuations = await (await app.get("/portfolio/valuations")).text();
      assert.match(valuations, /Fictional Bank FD/);
      assert.match(valuations, /computed from terms/);

      const overview = await (await app.get("/overview")).text();
      assert.match(overview, /Fictional Bank FD<\/a> matures/);
      const schedules = await (await app.get("/schedules?days=30")).text();
      assert.match(schedules, /Fictional Bank FD matures/);

      // A passbook figure typed on the valuations screen, dated today, wins.
      const v = await app.post("/portfolio/valuations", { [`value-${fd}`]: "1,06,000", [`asof-${fd}`]: today });
      assert.equal(v.status, 303);
      // ₹1,06,000 by hand, plus the private ₹50,000 deposit an unscoped total counts.
      assert.equal(netWorthStatement(db).netWorth, rupees(1_56_000));
      assert.match(await (await app.get("/portfolio/valuations")).text(), /valued by hand/);

      const gone = await app.post(`/accounts/${fd}/deposit/remove`, {});
      assert.equal(gone.status, 303);
      assert.equal(getDepositTerms(db, fd), null);
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });

  test("terms that cannot be priced are refused with a sentence", async () => {
    const { db, fd } = household();
    const app = await startTestApp(db, { memberId: RAVI });
    try {
      for (const bad of [{ deposit_rate: "seven" }, { deposit_maturity_date: addDays(today, -400) }, { deposit_kind: "bond" }]) {
        const r = await app.post(`/accounts/${fd}/deposit`, { ...terms, ...bad });
        assert.equal(r.status, 422, JSON.stringify(bad));
      }
      assert.equal(getDepositTerms(db, fd), null);
    } finally {
      await app.close();
    }
  });

  test("the new-account form offers terms and a deposit created with them values itself", async () => {
    const { db } = household();
    const app = await startTestApp(db, { memberId: RAVI });
    try {
      assert.match(await (await app.get("/accounts/new")).text(), /name="deposit_kind"/);
      const r = await app.post("/accounts/new", {
        name: "Fictional PPF", subtype: "tracking:asset", opening_balance: "", opening_date: "",
        deposit_kind: "ppf", deposit_principal: "150000", deposit_rate: "7.1",
        deposit_start_date: "2025-04-01", deposit_maturity_date: "",
      });
      assert.equal(r.status, 303);
      const id = queryOne<{ id: string }>(db, `SELECT id FROM accounts WHERE name = 'Fictional PPF'`)!.id;
      assert.equal(getDepositTerms(db, id)?.kind, "ppf");
      assert.equal(getDepositTerms(db, id)?.rateBp, 710);

      // Terms left empty: an ordinary account, as before.
      await app.post("/accounts/new", {
        name: "Fictional Plain FD", subtype: "tracking:fixed-deposit", opening_balance: "1000", deposit_kind: "",
      });
      const plain = queryOne<{ id: string }>(db, `SELECT id FROM accounts WHERE name = 'Fictional Plain FD'`)!.id;
      assert.equal(getDepositTerms(db, plain), null);

      // Bad terms leave no account behind.
      const bad = await app.post("/accounts/new", {
        name: "Fictional Broken FD", subtype: "tracking:fixed-deposit", deposit_kind: "fd", deposit_rate: "7",
      });
      assert.equal(bad.status, 422);
      assert.equal(queryOne(db, `SELECT 1 FROM accounts WHERE name = 'Fictional Broken FD'`), null);
    } finally {
      await app.close();
    }
  });

  test("UI-6 · a PPF given a current balance and no principal is worth that balance from the as-of date", async () => {
    // The weekly UI pass (P1): PPF, 7.1%, started 01-04-2020, current balance
    // ₹2,00,000, principal left blank. It was valued at ₹0, and dropped out of
    // net worth and FIRE, because the valuation reads principal plus register.
    const db = freshHousehold();
    const app = await startTestApp(db, { memberId: RAVI });
    try {
      const r = await app.post("/accounts/new", {
        name: "Fictional Running PPF", subtype: "tracking:asset", opening_balance: "2,00,000", opening_date: today,
        deposit_kind: "ppf", deposit_principal: "", deposit_rate: "7.1",
        deposit_start_date: "2020-04-01", deposit_maturity_date: "",
      });
      assert.equal(r.status, 303);
      const id = queryOne<{ id: string }>(db, `SELECT id FROM accounts WHERE name = 'Fictional Running PPF'`)!.id;
      const saved = getDepositTerms(db, id)!;
      assert.equal(saved.principal, rupees(2_00_000), "the opening balance is the principal");
      assert.equal(saved.startDate, today, "from the as-of date");

      assert.equal(netWorthStatement(db).netWorth, rupees(2_00_000));
      const fire = fireProjection(db, { asOf: today });
      assert.ok(fire.lockedLines.some((l) => l.accountId === id && l.value === rupees(2_00_000)), "FIRE counts it");

      const detail = await (await app.get(`/accounts/${id}`)).text();
      assert.match(detail, new RegExp(`worth ₹2,00,000(\\.00)? on ${formatDate(today)}, growing from there`));

      // A principal that is given is kept as given.
      await app.post("/accounts/new", {
        name: "Fictional Given PPF", subtype: "tracking:asset", opening_balance: "2,00,000", opening_date: today,
        deposit_kind: "ppf", deposit_principal: "150000", deposit_rate: "7.1",
        deposit_start_date: "2025-04-01", deposit_maturity_date: "",
      });
      const given = queryOne<{ id: string }>(db, `SELECT id FROM accounts WHERE name = 'Fictional Given PPF'`)!.id;
      assert.equal(getDepositTerms(db, given)?.principal, rupees(1_50_000));
      assert.equal(getDepositTerms(db, given)?.startDate, "2025-04-01");
      assert.doesNotMatch(await (await app.get(`/accounts/${given}`)).text(), /growing from there/);
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });

  test("another member can neither set terms on a private deposit nor see its maturity", async () => {
    const { db, secret } = household();
    const ravis = await startTestApp(db, { memberId: RAVI });
    const priyas = await startTestApp(db, { memberId: PRIYA });
    try {
      const refused = await priyas.post(`/accounts/${secret}/deposit`, terms);
      assert.equal(refused.status, 404);
      assert.equal((await priyas.post(`/accounts/${secret}/deposit/remove`, {})).status, 404);
      assert.equal(getDepositTerms(db, secret), null);

      assert.equal((await ravis.post(`/accounts/${secret}/deposit`, terms)).status, 303);
      for (const path of ["/overview", "/schedules?days=30", "/portfolio/valuations", "/activity"]) {
        const body = await (await priyas.get(path)).text();
        assert.doesNotMatch(body, /Quokka/, path);
      }
      assert.match(await (await ravis.get("/overview")).text(), /Quokka Private Deposit/);
    } finally {
      await ravis.close();
      await priyas.close();
    }
  });
});
