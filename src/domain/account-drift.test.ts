/**
 * When the ledger and the figure on screen disagree.
 *
 * Three kinds of account show a derived value, and each of them silently
 * ignored a transaction recorded against it. The app accepted the entry, stored
 * it, and then displayed a number that did not include it — which is the worst
 * shape a bug can take here, because nothing is visibly wrong.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute } from "../db/db.ts";
import { nowIST } from "../core/dates.ts";
import { rupees, type Paise } from "../core/money.ts";
import type { Actor } from "../core/events.ts";
import { createAccount } from "./accounts.ts";
import { createTransaction } from "./transactions.ts";
import { createAssetAccount, recordValuation } from "./assets.ts";
import { accountDrifts, DRIFT_THRESHOLD } from "./account-drift.ts";

const actor: Actor = { memberId: "m", source: "ui" };
const ASOF = "2026-09-30";

function household() {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    "m", "f@e.com", "Ravi", nowIST());
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    "m2", "p@e.com", "Priya", nowIST());
  return db;
}

describe("a stated valuation that money has moved past", () => {
  test("a contribution after the valuation is reported", () => {
    const db = household();
    const rd = createAccount(db, actor, {
      name: "RD", kind: "tracking", subtype: "recurring-deposit",
      openingDate: "2026-04-01", openingBalance: 0,
    }).id;
    recordValuation(db, actor, { accountId: rd, value: rupees(100_000), asOf: "2026-08-01" });
    createTransaction(db, actor, {
      accountId: rd, amount: rupees(10_000), date: "2026-09-01", categoryId: null,
    });

    const drifts = accountDrifts(db, { asOf: ASOF });
    const found = drifts.find((d) => d.accountId === rd);
    assert.ok(found, "a ₹10,000 contribution after the valuation went unreported");
    assert.equal(found!.kind, "stated-valuation");
    assert.equal(found!.gap, rupees(10_000));
    assert.equal(found!.since, "2026-08-01");
  });

  test("a movement before the valuation is not, because it is already in it", () => {
    const db = household();
    const rd = createAccount(db, actor, {
      name: "RD", kind: "tracking", subtype: "recurring-deposit",
      openingDate: "2026-04-01", openingBalance: 0,
    }).id;
    createTransaction(db, actor, {
      accountId: rd, amount: rupees(10_000), date: "2026-07-01", categoryId: null,
    });
    recordValuation(db, actor, { accountId: rd, value: rupees(100_000), asOf: "2026-08-01" });

    assert.equal(
      accountDrifts(db, { asOf: ASOF }).find((d) => d.accountId === rd), undefined,
      "a contribution the valuation already accounts for was reported as a gap",
    );
  });

  test("an account with no valuation at all is not reported", () => {
    // Its balance is what it is worth; nothing is being overridden.
    const db = household();
    const acc = createAccount(db, actor, {
      name: "Thing", kind: "tracking", subtype: "asset",
      openingDate: "2026-04-01", openingBalance: rupees(50_000),
    }).id;
    assert.equal(accountDrifts(db, { asOf: ASOF }).find((d) => d.accountId === acc), undefined);
  });

  test("small movements are rounding, not a forgotten entry", () => {
    const db = household();
    const rd = createAccount(db, actor, {
      name: "RD", kind: "tracking", subtype: "recurring-deposit",
      openingDate: "2026-04-01", openingBalance: 0,
    }).id;
    recordValuation(db, actor, { accountId: rd, value: rupees(100_000), asOf: "2026-08-01" });
    createTransaction(db, actor, {
      accountId: rd, amount: (DRIFT_THRESHOLD - 1) as Paise, date: "2026-09-01", categoryId: null,
    });
    assert.equal(accountDrifts(db, { asOf: ASOF }).find((d) => d.accountId === rd), undefined);
  });
});

describe("cash sitting in an investment account", () => {
  test("is reported, because net worth counts holdings and not this", () => {
    const db = household();
    const demat = createAssetAccount(db, actor, {
      name: "Zerodha", subtype: "investment", currency: "INR",
    });
    createTransaction(db, actor, {
      accountId: demat.id, amount: rupees(50_000), date: "2026-09-01", categoryId: null,
    });

    const found = accountDrifts(db, { asOf: ASOF }).find((d) => d.accountId === demat.id);
    assert.ok(found, "₹50,000 transferred in and not invested was counted nowhere, silently");
    assert.equal(found!.kind, "uninvested");
    assert.equal(found!.gap, rupees(50_000));
  });

  test("an empty investment account is quiet", () => {
    const db = household();
    const demat = createAssetAccount(db, actor, {
      name: "Zerodha", subtype: "investment", currency: "INR",
    });
    assert.equal(accountDrifts(db, { asOf: ASOF }).find((d) => d.accountId === demat.id), undefined);
  });
});

describe("whose drift it is", () => {
  test("another member's private account is not reported to this one", () => {
    /*
     * Naming it would disclose that the account exists, which is the whole
     * point of a private account.
     */
    const db = household();
    const rd = createAccount(db, actor, {
      name: "Her RD", kind: "tracking", subtype: "recurring-deposit",
      openingDate: "2026-04-01", openingBalance: 0,
      holderMemberId: "m2", visibility: "private",
    }).id;
    recordValuation(db, actor, { accountId: rd, value: rupees(100_000), asOf: "2026-08-01" });
    createTransaction(db, actor, {
      accountId: rd, amount: rupees(10_000), date: "2026-09-01", categoryId: null,
    });

    assert.equal(
      accountDrifts(db, { viewerMemberId: "m", asOf: ASOF }).find((d) => d.accountId === rd),
      undefined,
      "another member's private account drift was published",
    );
    assert.ok(
      accountDrifts(db, { viewerMemberId: "m2", asOf: ASOF }).find((d) => d.accountId === rd),
      "the owner cannot see their own drift",
    );
  });
});
