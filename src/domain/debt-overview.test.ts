/**
 * "Everything you owe" has to mean everything.
 *
 * The table showed loans and credit cards. A household that had borrowed from a
 * cousin, or written down an amount owed with no schedule behind it, saw a
 * heading claiming completeness over a table that did not have it — which is
 * worse than a narrower heading would have been.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute } from "../db/db.ts";
import { nowIST } from "../core/dates.ts";
import { rupees, type Paise } from "../core/money.ts";
import type { Actor } from "../core/events.ts";
import { createAccount } from "./accounts.ts";
import { createTransaction } from "./transactions.ts";
import { debtOverview } from "./loans.ts";

const actor: Actor = { memberId: "m", source: "ui" };

function household() {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    "m", "f@e.com", "Ravi", nowIST());
  return db;
}

describe("debts with no schedule", () => {
  test("an other-liability appears", () => {
    const db = household();
    createAccount(db, actor, {
      name: "Owed to a cousin", kind: "tracking", subtype: "liability",
      openingDate: "2026-04-01", openingBalance: -rupees(60_000) as Paise,
    });

    const row = debtOverview(db).find((r) => r.name === "Owed to a cousin");
    assert.ok(row, "a stated debt was missing from a table that claims to hold everything");
    assert.equal(row!.balance, rupees(60_000));
    assert.equal(row!.kind, "other");
  });

  test("with no rate and no monthly figure, rather than a misleading zero", () => {
    const db = household();
    createAccount(db, actor, {
      name: "Owed", kind: "tracking", subtype: "liability",
      openingDate: "2026-04-01", openingBalance: -rupees(60_000) as Paise,
    });
    const row = debtOverview(db).find((r) => r.name === "Owed")!;
    assert.equal(row.ratePct, null, "a rate of zero would read as an interest-free loan");
    assert.equal(row.monthsRemaining, null);
  });

  test("an other-asset with a positive value is not a debt", () => {
    const db = household();
    createAccount(db, actor, {
      name: "Jewellery", kind: "tracking", subtype: "asset",
      openingDate: "2026-04-01", openingBalance: rupees(200_000),
    });
    assert.equal(
      debtOverview(db).find((r) => r.name === "Jewellery"), undefined,
      "an asset was listed among the things you owe",
    );
  });

  test("a liability with no balance yet is not guessed at", () => {
    const db = household();
    createAccount(db, actor, {
      name: "Unknown", kind: "tracking", subtype: "liability",
      openingDate: "2026-04-01", openingBalance: 0,
    });
    assert.equal(debtOverview(db).find((r) => r.name === "Unknown"), undefined);
  });

  test("repaying some of it moves the figure by itself", () => {
    /*
     * The reason it reads the balance and not a stated number: a stated one
     * would still say ₹60,000 after ₹20,000 had been paid back.
     */
    const db = household();
    const id = createAccount(db, actor, {
      name: "Owed", kind: "tracking", subtype: "liability",
      openingDate: "2026-04-01", openingBalance: -rupees(60_000) as Paise,
    }).id;
    createTransaction(db, actor, {
      accountId: id, amount: rupees(20_000), date: "2026-09-01", categoryId: null,
    });
    assert.equal(debtOverview(db).find((r) => r.name === "Owed")!.balance, rupees(40_000));
  });
});
