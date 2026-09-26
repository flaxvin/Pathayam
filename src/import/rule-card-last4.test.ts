/**
 * IMPORTS-SCHEDULES-23 · A rule on "the card's last four digits" fires.
 *
 * /rules offers the field, and the pipeline resolves the card two lines before
 * it builds the rule subject — then passed cardLast4: null, so the rule could
 * never match. An alert for the 4321 add-on and a statement row "POS XX4321"
 * both knew the card and both staged uncategorised. Applying the rule to
 * existing transactions was equally blind.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Actor } from "../core/events.ts";
import { createAccount, createCard } from "../domain/accounts.ts";
import { createGroup, createCategory } from "../domain/budget.ts";
import { createTransaction } from "../domain/transactions.ts";
import { ingest, listStaged } from "./pipeline.ts";
import { previewRetroactive } from "./learning.ts";
import type { Rule } from "./rules.ts";
import { freshDb, seedMember, startTestApp } from "../web/harness.test-data.ts";

const actor: Actor = { memberId: "m-ravi", source: "ui" };

describe("IMPORTS-SCHEDULES-23 · card last four in rules", () => {
  test("an alert and a statement row on the add-on are filed by the rule", async () => {
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    const card = createAccount(db, actor, {
      name: "ZZ Card", kind: "credit", subtype: "credit-card", openingDate: "2026-01-01",
    });
    const addon = createCard(db, actor, { accountId: card.id, label: "ZZ add-on", last4: "4321" });
    const g = createGroup(db, actor, "ZZ Group");
    const hers = createCategory(db, actor, { groupId: g.id, name: "ZZ Add-on spends" }).id;
    const app = await startTestApp(db, { memberId: "m-ravi" });
    try {
      assert.equal((await app.post("/rules/new", {
        name: "ZZ Add-on", field: "cardLast4", op: "is", value: "4321", category_id: hers,
      })).status, 303);
      ingest(db, actor, {
        accountId: card.id, source: "email", adapter: "email:zz", records: [{
          rowNumber: 0, date: "2026-09-03", amount: -129900, narration: "ZZ SHOP", reference: null,
          raw: { date: "03-09-26", amount: "INR 1,299.00", narration: "ZZ SHOP" }, cardId: addon.id,
        }],
      });
      await app.post("/import", {
        account_id: card.id, file_name: "zz.csv",
        csv: "Date,Narration,Amount\n04-09-2026,POS XX4321 ZZ GROCER,-780.00",
      });
      const staged = listStaged(db);
      assert.equal(staged.length, 2);
      for (const row of staged) {
        assert.equal(row.card_id, addon.id);
        assert.equal(row.category_id, hers, row.raw_narration);
      }
    } finally {
      await app.close();
    }
  });

  test("'Apply to existing' sees the card of a posted transaction", () => {
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    const card = createAccount(db, actor, {
      name: "ZZ Card", kind: "credit", subtype: "credit-card", openingDate: "2026-01-01",
    });
    const addon = createCard(db, actor, { accountId: card.id, label: "ZZ add-on", last4: "4321" });
    const g = createGroup(db, actor, "ZZ Group");
    const other = createCategory(db, actor, { groupId: g.id, name: "ZZ Other" }).id;
    const hers = createCategory(db, actor, { groupId: g.id, name: "ZZ Add-on spends" }).id;
    createTransaction(db, actor, {
      accountId: card.id, date: "2026-09-05", amount: -50000, categoryId: other,
      payeeName: "ZZ Shop", cardId: addon.id,
    });
    const rule: Rule = {
      id: "r", name: "ZZ Add-on", stage: "default", match: "all", enabled: true,
      conditions: [{ field: "cardLast4", op: "is", value: "4321" }],
      actions: [{ type: "setCategory", categoryId: hers }],
    };
    assert.equal(previewRetroactive(db, rule).count, 1);
  });
});
