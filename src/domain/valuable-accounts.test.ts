/**
 * B56 · One asset system, two ways of knowing what a thing is worth.
 *
 * An asset entered on the accounts form was valued by its register and could
 * never be revalued; one entered in Portfolio was valued by dated valuations
 * and never appeared in a register. Only the second reached the valuations
 * screen, so a PPF added by the obvious door sat at its opening figure for as
 * long as the household owned it.
 *
 * The rule now: a tracking account is worth its balance unless somebody has
 * stated otherwise, and a dated valuation is how you state otherwise.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, type DB } from "../db/db.ts";
import { nowIST } from "../core/dates.ts";
import { rupees, type Paise } from "../core/money.ts";
import type { Actor } from "../core/events.ts";
import { createAccount } from "./accounts.ts";
import { listValuableAccounts, listAssetAccounts, recordValuation, createAssetAccount } from "./assets.ts";
import { netWorthStatement } from "./networth.ts";

const actor: Actor = { memberId: "m", source: "ui" };

function setup(): DB {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    "m", "m@example.com", "Ravi", nowIST());
  return db;
}

function lineFor(db: DB, name: string): { value: Paise; href?: string } | null {
  const statement = netWorthStatement(db);
  for (const group of [...statement.assetGroups, ...statement.liabilityGroups]) {
    const line = group.lines.find((l) => l.label === name || l.label.startsWith(`${name} (`));
    if (line) return { value: line.value, href: line.href };
  }
  return null;
}

describe("B56 · an asset entered on the accounts form can be revalued", () => {
  test("a plain tracking account is offered for valuation", () => {
    const db = setup();
    const ppf = createAccount(db, actor, {
      name: "PPF", kind: "tracking", subtype: "asset",
      openingBalance: rupees(3_10_000), openingDate: "2024-04-01",
    });

    // The portfolio's own list still means what it always meant.
    assert.equal(listAssetAccounts(db).some((a) => a.id === ppf.id), false);
    // The valuation surface covers it.
    assert.equal(listValuableAccounts(db).some((a) => a.id === ppf.id), true);
    db.close();
  });

  test("until it is revalued, it is worth its balance", () => {
    const db = setup();
    createAccount(db, actor, {
      name: "PPF", kind: "tracking", subtype: "asset",
      openingBalance: rupees(3_10_000), openingDate: "2024-04-01",
    });
    const line = lineFor(db, "PPF")!;
    assert.equal(line.value, rupees(3_10_000));
    // With nothing stated, the register is where you go to change it.
    assert.match(line.href!, /^\/accounts\//);
    db.close();
  });

  test("a stated valuation wins, and carries its own date", () => {
    const db = setup();
    const ppf = createAccount(db, actor, {
      name: "PPF", kind: "tracking", subtype: "asset",
      openingBalance: rupees(3_10_000), openingDate: "2024-04-01",
    });
    recordValuation(db, actor, {
      accountId: ppf.id, value: rupees(4_05_000) as Paise, asOf: "2026-04-01",
    });

    const line = lineFor(db, "PPF")!;
    assert.equal(line.value, rupees(4_05_000), "the balance no longer decides it");
    assert.match(line.href!, /\/revalue$/);

    // And it is counted once, not once per system.
    const statement = netWorthStatement(db);
    const appearances = [...statement.assetGroups, ...statement.liabilityGroups]
      .flatMap((g) => g.lines)
      .filter((l) => l.label.startsWith("PPF"));
    assert.equal(appearances.length, 1);
    db.close();
  });

  test("a tracking liability still reads as a liability when stated", () => {
    const db = setup();
    const owed = createAccount(db, actor, {
      name: "Deposit held", kind: "tracking", subtype: "liability",
      openingBalance: -rupees(50_000), openingDate: "2024-04-01",
    });
    recordValuation(db, actor, {
      accountId: owed.id, value: -rupees(30_000) as Paise, asOf: "2026-04-01",
    });
    const statement = netWorthStatement(db);
    const liability = statement.liabilityGroups
      .flatMap((g) => g.lines)
      .find((l) => l.label === "Deposit held");
    assert.ok(liability, "it stayed on the liability side");
    assert.equal(liability!.value, rupees(30_000), "shown as a positive amount owed");
    db.close();
  });

  test("a Portfolio-created asset is unaffected", () => {
    const db = setup();
    const gold = createAssetAccount(db, actor, {
      name: "Gold", subtype: "commodity", openingValue: rupees(1_00_000) as Paise,
      asOf: "2026-01-01",
    });
    assert.equal(listAssetAccounts(db).some((a) => a.id === gold.id), true);
    assert.equal(listValuableAccounts(db).some((a) => a.id === gold.id), true);
    const line = lineFor(db, "Gold")!;
    assert.equal(line.value, rupees(1_00_000));
    db.close();
  });
});
