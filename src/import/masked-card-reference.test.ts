/**
 * IMP-1 · A masked card number is not a bank reference.
 *
 * The narration's "reference" is its longest run of six or more digits. On a
 * debit-card line — "POS 416021XXXXXX1234 BIGBAZAAR", "ATW-416021XXXXXX1234-…"
 * — that run is the card's BIN, printed identically on every swipe. The strong
 * dedupe tier treats an equal reference as the same event and folds the new
 * row into the old one without asking, so a second ₹500 card purchase, or a
 * second ₹10,000 ATM withdrawal, within five days of an approved one vanished:
 * not staged, not in the ledger, counted only as "1 possible duplicate" with
 * nothing in Review to look at.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Actor } from "../core/events.ts";
import { createAccount } from "../domain/accounts.ts";
import { createGroup, createCategory } from "../domain/budget.ts";
import { parseStatement } from "./csv.ts";
import { ingest, listStaged, approveStaged } from "./pipeline.ts";
import { extractNarrationFields } from "./rules.ts";
import { freshHousehold, RAVI } from "../engine/identity.test-data.ts";

const actor: Actor = { memberId: RAVI, source: "ui" };

function household() {
  const db = freshHousehold();
  const account = createAccount(db, actor, {
    name: "ZZ Savings", kind: "budget", subtype: "savings", openingDate: "2026-01-01",
  }).id;
  const cat = createCategory(db, actor, { groupId: createGroup(db, actor, "ZZ G").id, name: "ZZ E" }).id;
  const imp = (csv: string) => {
    const { result } = parseStatement(csv);
    return ingest(db, actor, {
      accountId: account, source: "csv", adapter: "csv", fileName: "zz.csv",
      records: result.records, errors: result.errors, rowsRead: result.rowsRead,
    });
  };
  return { db, cat, imp };
}

describe("IMP-1 · masked card numbers are not references", () => {
  test("a masked card number gives no reference", () => {
    for (const n of [
      "POS 416021XXXXXX1234 BIGBAZAAR KOCHI",
      "ATW-416021XXXXXX1234-S1ANKC12-KOCHI",
      "POS 416021******1234 SWIGGY",
      "CARD XXXXXXXXXX123456 PURCHASE",
    ]) {
      assert.equal(extractNarrationFields(n).reference, null, n);
    }
  });

  test("a real reference beside a masked card is still found", () => {
    assert.equal(
      extractNarrationFields("POS 416021XXXXXX1234 SWIGGY 612345678901").reference,
      "612345678901",
    );
    assert.equal(extractNarrationFields("UPI/123456789012/SWIGGY/swiggy@icici").reference, "123456789012");
  });

  test("a second card purchase of the same amount days later is staged, not swallowed", () => {
    const { db, cat, imp } = household();
    imp("Date,Narration,Amount\n29-08-2026,POS 416021XXXXXX1234 BIGBAZAAR KOCHI,-500.00");
    for (const r of listStaged(db)) approveStaged(db, actor, r.id, { categoryId: cat });

    const next = imp("Date,Narration,Amount\n01-09-2026,POS 416021XXXXXX1234 SWIGGY BANGALORE,-500.00");
    assert.equal(next.staged, 1);
    assert.equal(listStaged(db).length, 1);
  });

  test("two ATM withdrawals at the same machine, two statements apart, both arrive", () => {
    const { db, cat, imp } = household();
    imp("Date,Narration,Amount\n30-08-2026,ATW-416021XXXXXX1234-S1ANKC12-KOCHI,-10000.00");
    for (const r of listStaged(db)) approveStaged(db, actor, r.id, { categoryId: cat });

    imp("Date,Narration,Amount\n02-09-2026,ATW-416021XXXXXX1234-S1ANKC12-KOCHI,-10000.00");
    assert.equal(listStaged(db).length, 1);
  });
});
