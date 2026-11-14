/**
 * Decision 10 (P2) · A "matches a pattern" rule cannot stall imports.
 *
 * A member's regex ran unbounded over every imported narration, and on the
 * public demo any visitor could write one: (a+)+$ against a long run of the
 * same letter backtracks for minutes, on every row of every import. Such a
 * pattern is now refused when the rule is saved (or tested), one stored before
 * is skipped with a warning rather than run, and only the first 500 characters
 * of a narration are ever tested.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execute, newId, queryAll } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { createAccount } from "../domain/accounts.ts";
import { createGroup, createCategory } from "../domain/budget.ts";
import { nowIST } from "../core/dates.ts";
import {
  evaluateCondition, extractNarrationFields, patternProblem, PATTERN_INPUT_LIMIT,
  type RuleSubject,
} from "./rules.ts";
import { listStaged } from "./pipeline.ts";
import { freshDb, seedMember, startTestApp } from "../web/harness.test-data.ts";

const actor: Actor = { memberId: "m-ravi", source: "ui" };

function subject(narration: string): RuleSubject {
  return {
    ...extractNarrationFields(narration),
    narration, payee: null, importedPayee: null, account: "a", amount: -100, absoluteAmount: 100,
    direction: "out", date: "2026-09-01", dayOfMonth: 1, memo: null, tags: [], category: null,
    cleared: false, source: "csv", cardLast4: null,
  } as unknown as RuleSubject;
}

describe("Decision 10 · which patterns a rule may hold", () => {
  test("refuses nested repeats, overlapping repeated choices, too many repeats and over-long patterns", () => {
    // These patterns are deliberately catastrophic: the test proves they are refused.
    // They live in a JSON file so the code scanner does not report test data as a
    // vulnerable regex in our own code; patternProblem only compiles them, never runs them.
    const evilPatterns = JSON.parse(
      readFileSync(new URL("./evil-patterns.test-data.json", import.meta.url), "utf8"),
    ) as string[];
    for (const evil of [...evilPatterns, "a".repeat(201)]) {
      assert.ok(patternProblem(evil), `should refuse ${evil.slice(0, 40)}`);
    }
  });

  test("accepts the patterns a household writes", () => {
    for (const fine of [
      "SWIGGY", "^UPI.*SWIGGY.*$", "AMAZON|FLIPKART", "(foo|bar)+", "\\d{2}-\\d{2}", "^NEFT/[A-Z0-9]+/",
      "(\\d{2})+", "colou?r", "a{2,5}", "\\(a+\\)+", "[(a+)+]", "(?<n>ab)c\\k<n>", "a".repeat(200),
    ]) {
      assert.equal(patternProblem(fine), null, fine);
    }
  });

  test("a classic evil pattern is refused by /rules/new and /rules/test, quickly, and nothing is saved", async () => {
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    const g = createGroup(db, actor, "ZZ Group");
    const cat = createCategory(db, actor, { groupId: g.id, name: "ZZ Eating" }).id;
    const account = createAccount(db, actor, {
      name: "ZZ Savings", kind: "budget", subtype: "savings", openingDate: "2026-01-01",
    });
    const app = await startTestApp(db, { memberId: "m-ravi" });
    try {
      // History a /rules/test would run the pattern over.
      await app.post("/import", {
        account_id: account.id, file_name: "zz.csv",
        csv: `Date,Narration,Amount\n03-09-2026,${"a".repeat(29)}!,-60.00`,
      });
      const started = Date.now();
      for (const path of ["/rules/test", "/rules/new"]) {
        const res = await app.post(path, {
          name: "ZZ Evil", field: "narration", op: "matches", value: "(a+)+$", category_id: cat,
        });
        assert.equal(res.status, 422, path);
        assert.match(await res.text(), /repeat something that itself repeats/, path);
      }
      assert.ok(Date.now() - started < 2_000, `took ${Date.now() - started} ms`);
      assert.deepEqual(queryAll(db, `SELECT 1 FROM rules WHERE name = 'ZZ Evil'`), []);

      // A good one still saves.
      assert.equal((await app.post("/rules/new", {
        name: "ZZ Swiggy", field: "narration", op: "matches", value: "^UPI.*SWIGGY", category_id: cat,
      })).status, 303);
    } finally { await app.close(); }
  });
});

describe("Decision 10 · at match time", () => {
  test("a bad pattern stored before is skipped, with a warning, instead of stalling an import", async (t) => {
    const warned: string[] = [];
    t.mock.method(console, "warn", (...args: unknown[]) => { warned.push(args.join(" ")); });
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    const g = createGroup(db, actor, "ZZ Group");
    const cat = createCategory(db, actor, { groupId: g.id, name: "ZZ Eating" }).id;
    const account = createAccount(db, actor, {
      name: "ZZ Savings", kind: "budget", subtype: "savings", openingDate: "2026-01-01",
    });
    execute(db,
      `INSERT INTO rules (id,name,stage,conditions_json,actions_json,enabled,proposed,created_at,created_by)
       VALUES (?,?,?,?,?,1,0,?,?)`,
      newId(), "ZZ Old evil", "default",
      JSON.stringify([{ field: "narration", op: "matches", value: "(a+)+$" }]),
      JSON.stringify([{ type: "setCategory", categoryId: cat }]), nowIST(), "m-ravi");
    const app = await startTestApp(db, { memberId: "m-ravi" });
    try {
      const started = Date.now();
      await app.post("/import", {
        account_id: account.id, file_name: "zz.csv",
        csv: `Date,Narration,Amount\n03-09-2026,${"a".repeat(28)}!,-60.00\n04-09-2026,${"a".repeat(30)},-70.00`,
      });
      assert.ok(Date.now() - started < 2_000, `took ${Date.now() - started} ms`);
      assert.equal(listStaged(db).length, 2);
      assert.ok(listStaged(db).every((r) => r.category_id === null));
      assert.ok(warned.some((w) => /skipped a "matches a pattern" condition/.test(w)), warned.join("\n"));
      assert.deepEqual(app.failures, []);
    } finally { await app.close(); }
  });

  test(`only the first ${PATTERN_INPUT_LIMIT} characters of a narration are tested`, () => {
    const cond = { field: "narration", op: "matches", value: "SWIGGY" } as const;
    assert.equal(evaluateCondition(subject(`UPI/SWIGGY/${"x".repeat(600)}`), cond), true);
    assert.equal(evaluateCondition(subject(`${"x".repeat(PATTERN_INPUT_LIMIT)}SWIGGY`), cond), false);
  });
});
