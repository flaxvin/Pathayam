/**
 * DEPOSITS · A deposit with terms is worth what they say, everywhere.
 *
 * Net worth, the allocation, FIRE, the cashflow calendar and the activity log
 * all read the computed figure; a hand valuation dated on or after its basis
 * date wins over it; and a private deposit stays its holder's.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { queryOne } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { undoEvent, queryEvents } from "../core/events.ts";
import { rupees } from "../core/money.ts";
import { todayIST, addDays } from "../core/dates.ts";
import { Refusal } from "../core/refusal.ts";
import { freshHousehold, RAVI, PRIYA } from "../engine/identity.test-data.ts";
import { createAccount } from "./accounts.ts";
import { createTransaction } from "./transactions.ts";
import { recordValuation, standingValuation, createAssetAccount } from "./assets.ts";
import { netWorthStatement, assetAllocation } from "./networth.ts";
import { fireProjection } from "./fire.ts";
import { projectCashflow } from "./schedules.ts";
import { accountDrifts } from "./account-drift.ts";
import { eventVisibility } from "./event-visibility.ts";
import {
  setDepositTerms, removeDepositTerms, getDepositTerms, computedDepositValue, listMaturities,
} from "./deposits.ts";

const ravi: Actor = { memberId: RAVI, source: "ui" };

function withFd(opts: { visibility?: "private" } = {}) {
  const db = freshHousehold();
  const fd = createAccount(db, ravi, {
    name: "Fictional Bank FD", kind: "tracking", subtype: "fixed-deposit",
    openingDate: "2025-01-01", openingBalance: rupees(1_00_000),
    holderMemberId: opts.visibility ? RAVI : null, visibility: opts.visibility,
  }).id;
  return { db, fd };
}

const FD_TERMS = {
  kind: "fd", principal: rupees(1_00_000), rateBp: 700, startDate: "2025-01-01", maturityDate: "2026-01-01",
};

describe("DEPOSITS · net worth uses the computed value", () => {
  test("an FD with terms counts at what they make it, not its balance", () => {
    const { db, fd } = withFd();
    const before = netWorthStatement(db, "2025-07-01").netWorth;
    assert.equal(before, rupees(1_00_000), "worth its balance without terms");

    setDepositTerms(db, ravi, fd, FD_TERMS, "2025-01-01");
    const nw = netWorthStatement(db, "2025-07-01");
    assert.equal(nw.netWorth, 1_03_53_063, "1,00,000 × 1.0175²");
    const line = nw.assetGroups.flatMap((g) => g.lines).find((l) => l.accountId === fd)!;
    assert.equal(line.href, `/accounts/${fd}`);

    // Matured: held at its maturity value until somebody records the money.
    assert.equal(netWorthStatement(db, "2026-03-01").netWorth, 1_07_18_590);
  });

  test("the allocation and FIRE read the same figure", () => {
    const { db, fd } = withFd();
    setDepositTerms(db, ravi, fd, FD_TERMS, "2025-01-01");
    const allocation = assetAllocation(db, "2025-07-01");
    assert.equal(allocation.byClass.find((s) => s.key === "cash")?.value, 1_03_53_063);
    const fire = fireProjection(db, { asOf: "2025-07-01" });
    assert.equal(fire.drawableLines.find((l) => l.accountId === fd)?.value, 1_03_53_063);
  });

  test("a PPF on an other-asset account is locked for FIRE and debt in the allocation", () => {
    const db = freshHousehold();
    const ppf = createAccount(db, ravi, {
      name: "Fictional PPF", kind: "tracking", subtype: "asset", openingDate: "2025-04-01",
    }).id;
    setDepositTerms(db, ravi, ppf, {
      kind: "ppf", principal: rupees(1_50_000), rateBp: 710, startDate: "2025-04-01",
    }, "2025-04-01");
    assert.equal(netWorthStatement(db, "2026-03-31").netWorth, rupees(1_60_650));
    assert.equal(fireProjection(db, { asOf: "2026-03-31" }).lockedLines[0]?.value, rupees(1_60_650));
    assert.equal(assetAllocation(db, "2026-03-31").byClass[0]?.key, "debt");
  });
});

describe("DEPOSITS · a hand valuation on or after the basis date wins", () => {
  test("a passbook figure dated after the terms were set stands; one before them does not", () => {
    const { db, fd } = withFd();
    recordValuation(db, ravi, { accountId: fd, value: rupees(99_000), asOf: "2025-03-01" });
    setDepositTerms(db, ravi, fd, FD_TERMS, "2025-04-01");

    // The March valuation predates the terms: superseded.
    let v = standingValuation(db, fd, "2025-07-01")!;
    assert.equal(v.source, "terms");
    assert.equal(v.value, 1_03_53_063);

    recordValuation(db, ravi, { accountId: fd, value: rupees(1_03_000), asOf: "2025-06-30" });
    v = standingValuation(db, fd, "2025-07-01")!;
    assert.equal(v.source, "hand");
    assert.equal(v.value, rupees(1_03_000));
    assert.equal(netWorthStatement(db, "2025-07-01").netWorth, rupees(1_03_000));

    // Saving the terms again makes them the newer information.
    setDepositTerms(db, ravi, fd, FD_TERMS, "2025-07-01");
    assert.equal(standingValuation(db, fd, "2025-07-01")!.source, "terms");
  });

  test("for a PPF, a contribution after the valuation hands it back to the terms, and is counted", () => {
    const db = freshHousehold();
    const ppf = createAccount(db, ravi, {
      name: "Fictional PPF", kind: "tracking", subtype: "asset", openingDate: "2025-04-01",
    }).id;
    setDepositTerms(db, ravi, ppf, {
      kind: "ppf", principal: rupees(1_50_000), rateBp: 710, startDate: "2025-04-01",
    }, "2025-04-01");
    recordValuation(db, ravi, { accountId: ppf, value: rupees(1_55_000), asOf: "2025-05-01" });
    assert.equal(standingValuation(db, ppf, "2025-06-01")!.source, "hand");

    createTransaction(db, ravi, { accountId: ppf, amount: rupees(10_000), date: "2025-06-03" });
    const computed = computedDepositValue(db, ppf, "2026-03-31")!;
    assert.equal(computed.basisDate, "2025-06-03");
    const v = standingValuation(db, ppf, "2026-03-31")!;
    assert.equal(v.source, "terms");
    // 1,50,000 × 7.1% + 10,000 × 7.1% × 10/12 (June to March) = 10,650 + 591.67
    assert.equal(v.value, rupees(1_60_000) + 11_24_167);
    // And nothing reports a drift: the contribution is in the figure.
    assert.equal(accountDrifts(db, { asOf: "2026-03-31" }).length, 0);
  });
});

describe("DEPOSITS · setting, removing and undoing terms", () => {
  test("terms go only on a deposit-like tracking account", () => {
    const db = freshHousehold();
    const bank = createAccount(db, ravi, {
      name: "Bank", kind: "budget", subtype: "savings", openingDate: "2025-01-01",
    }).id;
    const gold = createAssetAccount(db, ravi, { name: "Gold", subtype: "commodity" }).id;
    for (const id of [bank, gold]) {
      assert.throws(() => setDepositTerms(db, ravi, id, FD_TERMS), Refusal);
    }
  });

  test("set, change and remove each undo from the log", () => {
    const { db, fd } = withFd();
    setDepositTerms(db, ravi, fd, FD_TERMS);
    setDepositTerms(db, ravi, fd, { ...FD_TERMS, rateBp: 725 });
    removeDepositTerms(db, ravi, fd);
    assert.equal(getDepositTerms(db, fd), null);

    const events = queryEvents(db, { entity: "deposit-terms", entityId: fd, descending: true, limit: 10 });
    assert.deepEqual(events.map((e) => e.action), ["remove", "set", "set"]);

    assert.ok(undoEvent(db, events[0]!.id, ravi).ok);
    assert.equal(getDepositTerms(db, fd)?.rateBp, 725, "the removal undone puts the terms back");
    assert.ok(undoEvent(db, events[1]!.id, ravi, { force: true }).ok);
    assert.equal(getDepositTerms(db, fd)?.rateBp, 700, "the change undone puts back the old rate");
    assert.ok(undoEvent(db, events[2]!.id, ravi, { force: true }).ok);
    assert.equal(getDepositTerms(db, fd), null, "the first set undone leaves no terms");
    assert.equal(netWorthStatement(db, "2025-07-01").netWorth, rupees(1_00_000));
  });

  test("an account with terms is not removed by undoing its creation", () => {
    const { db, fd } = withFd();
    setDepositTerms(db, ravi, fd, FD_TERMS);
    const created = queryEvents(db, { entity: "account", entityId: fd, limit: 5 }).find((e) => e.action === "create")!;
    const r = (() => { try { return undoEvent(db, created.id, ravi, { force: true }); } catch (e) { return e; } })();
    assert.ok(r instanceof Refusal || (r as { ok: boolean }).ok === false);
    assert.ok(queryOne(db, `SELECT 1 FROM accounts WHERE id = ?`, fd));
  });
});

describe("DEPOSITS · maturities, and privacy", () => {
  test("a maturity is on the cashflow calendar beside the balance, not in it", () => {
    const { db, fd } = withFd();
    const today = todayIST();
    const matures = addDays(today, 10);
    setDepositTerms(db, ravi, fd, { ...FD_TERMS, startDate: addDays(today, -355), maturityDate: matures });
    const cashflow = projectCashflow(db, { days: 30, viewerMemberId: RAVI });
    const day = cashflow.days.find((d) => d.date === matures)!;
    assert.equal(day.maturing?.[0]?.accountId, fd);
    assert.ok(day.maturing![0]!.amount > rupees(1_00_000));
    assert.equal(cashflow.lowestBalance, cashflow.openingBalance, "the balance does not move");
    assert.equal(listMaturities(db, { from: today, to: addDays(today, 14), viewerMemberId: RAVI }).length, 1);
  });

  test("a private deposit's terms, maturity and log stay its holder's", () => {
    const { db, fd } = withFd({ visibility: "private" });
    const today = todayIST();
    setDepositTerms(db, ravi, fd, { ...FD_TERMS, startDate: addDays(today, -355), maturityDate: addDays(today, 10) });
    const window = { from: today, to: addDays(today, 14) };
    assert.equal(listMaturities(db, { ...window, viewerMemberId: RAVI }).length, 1);
    assert.equal(listMaturities(db, { ...window, viewerMemberId: PRIYA }).length, 0);
    assert.ok(projectCashflow(db, { days: 30, viewerMemberId: PRIYA }).days.every((d) => !d.maturing));
    const event = queryEvents(db, { entity: "deposit-terms", entityId: fd, limit: 1 })[0]!;
    assert.equal(eventVisibility(db, PRIYA)(event), false);
    assert.equal(eventVisibility(db, RAVI)(event), true);
    assert.equal(
      netWorthStatement(db, today, "INR", { viewerMemberId: PRIYA }).netWorth, 0,
      "nor is it in her net worth",
    );
  });
});
