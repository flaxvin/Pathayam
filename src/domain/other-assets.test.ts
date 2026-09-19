/**
 * "Other asset" and "other liability" — the plain tracking subtypes.
 *
 * Two faults reported together, and they compounded: these accounts appeared on
 * the revalue-everything screen but on no other, so a household could value one
 * and see nothing change anywhere — concluding, reasonably, that revaluing did
 * nothing. And when the value did land, a liability was stored positive, so net
 * worth counted a debt as an asset and moved by twice the amount in the wrong
 * direction.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute } from "../db/db.ts";
import { nowIST } from "../core/dates.ts";
import { rupees, formatPaise, type Paise } from "../core/money.ts";
import type { Actor } from "../core/events.ts";
import { createAccount } from "./accounts.ts";
import {
  listValuableAccounts, listAssetAccounts, recordValuation, latestValuation, signedValuation,
} from "./assets.ts";
import { netWorthStatement } from "./networth.ts";

const actor: Actor = { memberId: "m", source: "ui" };

function household() {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    "m", "f@e.com", "Ravi", nowIST());
  return db;
}

function tracking(db: ReturnType<typeof household>, name: string, subtype: string) {
  return createAccount(db, actor, {
    name, kind: "tracking", subtype: subtype as "asset",
    openingDate: "2026-04-01", openingBalance: 0,
  }).id;
}

describe("the sign a valuation carries", () => {
  test("a liability is stored negative, however it was typed", () => {
    // Somebody entering what they owe writes it positive, and is not wrong to.
    assert.equal(signedValuation("liability", rupees(50_000)), -rupees(50_000));
    assert.equal(signedValuation("liability", -rupees(50_000) as Paise), -rupees(50_000));
  });

  test("everything else is positive", () => {
    for (const subtype of ["asset", "physical", "commodity", "fixed-deposit"]) {
      assert.equal(signedValuation(subtype, rupees(50_000)), rupees(50_000), subtype);
    }
  });
});

describe("where they appear", () => {
  test("the plain subtypes are valuable accounts", () => {
    const db = household();
    const ids = [
      tracking(db, "Other thing", "asset"),
      tracking(db, "Other debt", "liability"),
      tracking(db, "SBI FD", "fixed-deposit"),
      tracking(db, "RD", "recurring-deposit"),
    ];
    const valuable = new Set(listValuableAccounts(db).map((a) => a.id));
    for (const id of ids) {
      assert.ok(valuable.has(id), "a revaluable account is missing from the list screens use");
    }
  });

  test("and are not in the narrower asset list, which is why the pages disagreed", () => {
    /*
     * Kept as a test rather than a comment: listAssetAccounts is deliberately
     * narrower, and a screen that means "everything valuable" must not reach
     * for it. The portfolio page did, so these accounts were revaluable and
     * invisible at the same time.
     */
    const db = household();
    const other = tracking(db, "Other thing", "asset");
    assert.ok(!listAssetAccounts(db).some((a) => a.id === other));
  });
});

describe("which page each belongs on", () => {
  test("a deposit is something you hold, so it is in the portfolio list", () => {
    const db = household();
    for (const subtype of ["fixed-deposit", "recurring-deposit", "asset"]) {
      const id = tracking(db, `A ${subtype}`, subtype);
      assert.ok(
        listValuableAccounts(db).some((a) => a.id === id && a.subtype !== "liability"),
        `${subtype} should be offered as something held`,
      );
    }
  });

  test("a liability is still revaluable, because it has to be", () => {
    const db = household();
    const id = tracking(db, "Other debt", "liability");
    assert.ok(
      listValuableAccounts(db).some((a) => a.id === id),
      "a debt you state by hand must still be revaluable somewhere",
    );
  });
});

describe("what a revaluation does to net worth", () => {
  test("an other-asset adds", () => {
    const db = household();
    const id = tracking(db, "Jewellery", "asset");
    recordValuation(db, actor, {
      accountId: id, value: signedValuation("asset", rupees(200_000)), asOf: "2026-09-01",
    });
    const s = netWorthStatement(db, "2026-09-30");
    assert.equal(
      s.totalAssets, rupees(200_000),
      `expected the valuation on the asset side, got ${formatPaise(s.totalAssets)}`,
    );
  });

  test("an other-liability subtracts, rather than doubling in the wrong direction", () => {
    const db = household();
    const id = tracking(db, "Money owed to a cousin", "liability");
    recordValuation(db, actor, {
      accountId: id, value: signedValuation("liability", rupees(50_000)), asOf: "2026-09-01",
    });

    const s = netWorthStatement(db, "2026-09-30");
    assert.equal(
      s.totalAssets, 0,
      "a debt was counted as an asset — net worth moves by twice it, the wrong way",
    );
    assert.equal(s.totalLiabilities, rupees(50_000));
    assert.equal(s.netWorth, -rupees(50_000));
  });

  test("the valuation that was stored is the one that comes back", () => {
    const db = household();
    const id = tracking(db, "Other debt", "liability");
    recordValuation(db, actor, {
      accountId: id, value: signedValuation("liability", rupees(50_000)), asOf: "2026-09-01",
    });
    assert.equal(latestValuation(db, id)?.value, -rupees(50_000));
  });
});
