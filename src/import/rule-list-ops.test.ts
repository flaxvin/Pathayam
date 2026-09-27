/**
 * EXTRA-2 · A rule whose test needs a list, given one value.
 *
 * The /rules form sends one typed value and offers no list test, but it
 * trusted the op it was posted: "oneOf" with the text "Zomato" was saved, and
 * the matcher called `.some` on the string in the middle of the next import —
 * which answered 500, as did every import after, until the rule was deleted.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execute, newId, queryOne } from "../db/db.ts";
import { nowIST } from "../core/dates.ts";
import type { Actor } from "../core/events.ts";
import { createAccount } from "../domain/accounts.ts";
import { createGroup, createCategory } from "../domain/budget.ts";
import { evaluateCondition, type Condition, type RuleSubject } from "./rules.ts";
import { listStaged } from "./pipeline.ts";
import { freshDb, seedMember, startTestApp } from "../web/harness.test-data.ts";

const actor: Actor = { memberId: "m-ravi", source: "ui" };

describe("EXTRA-2 · list tests on a rule", () => {
  test("the form refuses a list test, an unknown test and an unknown field", async () => {
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    const g = createGroup(db, actor, "ZZ Group");
    const food = createCategory(db, actor, { groupId: g.id, name: "ZZ Food" }).id;
    const app = await startTestApp(db, { memberId: "m-ravi" });
    try {
      for (const [field, op] of [["merchant", "oneOf"], ["merchant", "notOneOf"], ["absoluteAmount", "between"],
        ["merchant", "sortOf"], ["password", "is"]]) {
        const res = await app.post("/rules/new", { name: "ZZ crafted", field, op, value: "Zomato", category_id: food });
        assert.equal(res.status, 422, `${field} ${op}`);
        assert.equal((await app.post("/rules/test", { name: "ZZ crafted", field, op, value: "Zomato", category_id: food })).status, 422);
      }
      assert.equal(queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM rules WHERE name = 'ZZ crafted'`)!.n, 0);
    } finally {
      await app.close();
    }
  });

  test("a bad row already stored is read as a list of one, and the import goes through", async () => {
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    const account = createAccount(db, actor, {
      name: "ZZ Savings", kind: "budget", subtype: "savings", openingDate: "2026-01-01",
    });
    const g = createGroup(db, actor, "ZZ Group");
    const food = createCategory(db, actor, { groupId: g.id, name: "ZZ Food" }).id;
    execute(db,
      `INSERT INTO rules (id,name,stage,conditions_json,actions_json,enabled,proposed,created_at)
       VALUES (?,?,?,?,?,1,0,?)`,
      newId(), "ZZ stored", "default",
      JSON.stringify([{ field: "narration", op: "oneOf", value: "ZZ ZOMATO" },]),
      JSON.stringify([{ type: "setCategory", categoryId: food }]), nowIST());
    execute(db,
      `INSERT INTO rules (id,name,stage,conditions_json,actions_json,enabled,proposed,created_at)
       VALUES (?,?,?,?,?,1,0,?)`,
      newId(), "ZZ stored pair", "default",
      JSON.stringify([{ field: "absoluteAmount", op: "between", value: 500 }]),
      JSON.stringify([{ type: "setCategory", categoryId: food }]), nowIST());
    const app = await startTestApp(db, { memberId: "m-ravi" });
    try {
      const res = await app.post("/import", {
        account_id: account.id, file_name: "zz.csv",
        csv: "Date,Narration,Amount\n03-09-2026,ZZ ZOMATO,-300.00\n04-09-2026,ZZ OTHER,-5.00",
      });
      assert.equal(res.status, 303);
      const filed = new Map(listStaged(db).map((r) => [r.raw_narration, r.category_id]));
      assert.equal(filed.get("ZZ ZOMATO"), food);
      assert.equal(filed.get("ZZ OTHER"), null);
    } finally {
      await app.close();
    }
  });

  test("the matcher reads a lone value as a list, and a lone figure as no range", () => {
    const subject = { narration: "ZZ Zomato", amount: -500 } as unknown as RuleSubject;
    const c = (op: string, value: unknown) => ({ field: "narration", op, value }) as unknown as Condition;
    assert.equal(evaluateCondition(subject, c("oneOf", "zz zomato")), true);
    assert.equal(evaluateCondition(subject, c("notOneOf", "zz zomato")), false);
    assert.equal(evaluateCondition(subject, c("oneOf", ["ZZ Swiggy", "ZZ ZOMATO"])), true);
    assert.equal(evaluateCondition(subject, c("oneOf", [7, null])), false);
    assert.equal(evaluateCondition(subject,
      { field: "absoluteAmount", op: "between", value: 500 } as unknown as Condition), false);
    assert.equal(evaluateCondition(subject,
      { field: "absoluteAmount", op: "between", value: [100, 900] } as Condition), true);
  });
});
