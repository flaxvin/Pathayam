/**
 * WEB-3 · A tag used only on another member's private rows is not in my export.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember } from "../web/harness.test-data.ts";
import { execute } from "../db/db.ts";
import { nowIST } from "../core/dates.ts";
import { createAccount } from "../domain/accounts.ts";
import { createTransaction } from "../domain/transactions.ts";
import { exportForMember } from "./member-export.ts";

const RAVI = "m-ravi";
const PRIYA = "m-priya";
const ravi = { memberId: RAVI, source: "ui" as const };

test("WEB-3 · tags in /export.json follow the rows they are on", () => {
  const db = freshDb();
  seedMember(db, RAVI, "Ravi");
  seedMember(db, PRIYA, "Priya");
  const priv = createAccount(db, ravi, {
    name: "Ravi private", kind: "tracking", subtype: "savings", openingDate: "2026-01-01",
    openingBalance: 1_000_000, holderMemberId: RAVI, visibility: "private",
  });
  const joint = createAccount(db, ravi, {
    name: "Joint", kind: "budget", subtype: "savings", openingDate: "2026-01-01", openingBalance: 1_000_000,
  });
  createTransaction(db, ravi, {
    accountId: priv.id, amount: -50_000, date: "2026-09-01", tags: ["Divorcelawyer Zeta", "Goa trip"],
  });
  createTransaction(db, ravi, { accountId: joint.id, amount: -20_000, date: "2026-09-02", tags: ["Goa trip"] });
  execute(db, `INSERT INTO tags (id, name, created_at) VALUES ('t-unused', 'Diwali', ?)`, nowIST());

  const names = (memberId: string) => {
    const file = exportForMember(db, memberId) as { data: { tags: { name: string }[] } };
    return file.data.tags.map((t) => t.name).sort();
  };
  assert.deepEqual(names(PRIYA), ["Diwali", "Goa trip"]);
  assert.deepEqual(names(RAVI), ["Divorcelawyer Zeta", "Diwali", "Goa trip"]);
  db.close();
});
