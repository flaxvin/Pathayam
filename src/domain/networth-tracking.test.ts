/**
 * B56 · A plain tracking account (a fixed deposit, an "other asset" or "other
 * liability") counts in net worth by its balance. Before this it was created on
 * the accounts form and then appeared in no total at all — an orphan, the same
 * failure class as a family loan that never reached the Lending page.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import { createAccount } from "./accounts.ts";
import { netWorthStatement } from "./networth.ts";

const actor: Actor = { memberId: "m", source: "ui" };

function setup() {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    "m", "f@e.com", "Ravi", nowIST());
  return db;
}

describe("B56 · plain tracking accounts count in net worth", () => {
  test("a positive-balance asset and fixed deposit are assets", () => {
    const db = setup();
    createAccount(db, actor, { name: "Gold", kind: "tracking", subtype: "asset", openingBalance: rupees(50_000), openingDate: "2026-08-01" });
    createAccount(db, actor, { name: "SBI FD", kind: "tracking", subtype: "fixed-deposit", openingBalance: rupees(100_000), openingDate: "2026-08-01" });

    const nw = netWorthStatement(db, "2026-08-28");
    assert.equal(nw.totalAssets, rupees(150_000));
    const labels = nw.assetGroups.flatMap((g) => g.lines).map((l) => l.label);
    assert.ok(labels.includes("Gold") && labels.includes("SBI FD"));
    db.close();
  });

  test("a negative-balance tracking account is an 'Other liabilities' line", () => {
    const db = setup();
    createAccount(db, actor, { name: "IOU to shop", kind: "tracking", subtype: "liability", openingBalance: -rupees(20_000), openingDate: "2026-08-01" });

    const nw = netWorthStatement(db, "2026-08-28");
    assert.equal(nw.totalLiabilities, rupees(20_000));
    assert.equal(nw.netWorth, -rupees(20_000));
    const group = nw.liabilityGroups.find((g) => g.name === "Other liabilities");
    assert.ok(group, "an Other liabilities group exists");
    assert.equal(group!.lines[0]!.label, "IOU to shop");
    db.close();
  });

  test("a zero-balance tracking account adds nothing", () => {
    const db = setup();
    createAccount(db, actor, { name: "Empty FD", kind: "tracking", subtype: "fixed-deposit", openingBalance: 0, openingDate: "2026-08-01" });
    const nw = netWorthStatement(db, "2026-08-28");
    assert.equal(nw.totalAssets, 0);
    assert.equal(nw.totalLiabilities, 0);
    db.close();
  });
});
