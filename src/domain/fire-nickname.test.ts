/**
 * The FIRE page's "What is counted" list named accounts by their bank name
 * while every other screen uses the nickname, so the demo's "Business current"
 * appeared there as "ICICI Current" — an account the household could not find
 * on Accounts. Found comparing the two screens in a browser.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute } from "../db/db.ts";
import { nowIST } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import type { Actor } from "../core/events.ts";
import { createAccount } from "./accounts.ts";
import { fireProjection } from "./fire.ts";

const actor: Actor = { memberId: "m", source: "ui" };

test("FIRE lines use an account's nickname when it has one", () => {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`, "m", "f@e.com", "Ravi", nowIST());
  createAccount(db, actor, {
    name: "ICICI Current", nickname: "Business current", kind: "budget", subtype: "current",
    openingDate: "2025-01-01", openingBalance: rupees(24_000),
  });
  createAccount(db, actor, {
    name: "SBI Fixed Deposit 0042", nickname: "SBI FD", kind: "tracking", subtype: "fixed-deposit",
    openingDate: "2025-01-01", openingBalance: rupees(2_00_000),
  });
  createAccount(db, actor, {
    name: "Plain Bank", kind: "budget", subtype: "savings",
    openingDate: "2025-01-01", openingBalance: rupees(1_000),
  });
  const labels = fireProjection(db, { asOf: "2026-09-30" }).drawableLines.map((l) => l.label).sort();
  assert.deepEqual(labels, ["Business current", "Plain Bank", "SBI FD"]);
});
