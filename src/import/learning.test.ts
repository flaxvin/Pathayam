import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, queryAll, queryOne, type DB } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST, todayIST } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import { createAccount } from "../domain/accounts.ts";
import { createGroup, createCategory } from "../domain/budget.ts";
import { createTransaction } from "../domain/transactions.ts";
import {
  proposeCategoryRules, proposePayeeRule, previewRetroactive, applyRetroactive,
  suppress, setLearningEnabled, learningEnabled,
} from "./learning.ts";
import {
  recognise, saveProfile, listProfiles, mappingFromSelections, validateMapping,
  columnChoices, candidateHeaderRows, parseWith,
} from "./profiles.ts";
import type { Rule } from "./rules.ts";

const RAVI = "m-ravi";
const actor: Actor = { memberId: RAVI, source: "ui" };

function setup() {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    RAVI, "ravi@example.com", "Ravi", nowIST());
  const account = createAccount(db, actor, {
    name: "HDFC", kind: "budget", subtype: "savings", openingDate: "2026-08-01",
  });
  const group = createGroup(db, actor, "Flexible");
  const eatingOut = createCategory(db, actor, { groupId: group.id, name: "Eating Out" });
  const groceries = createCategory(db, actor, { groupId: group.id, name: "Groceries" });
  return { db, account, eatingOut, groceries };
}

function spend(
  db: DB, accountId: string, payee: string, categoryId: string | null, date: string,
  narration?: string,
) {
  return createTransaction(db, actor, {
    accountId, amount: rupees(-450), date, payeeName: payee, categoryId,
    raw: narration ? { narration } : undefined,
  });
}

describe("04 §6.4 · rule learning", () => {
  test("L2 — proposes on the second categorisation, not the first", () => {
    const { db, account, eatingOut } = setup();

    spend(db, account.id, "Swiggy", eatingOut.id, "2026-08-01");
    assert.deepEqual(proposeCategoryRules(db, actor), [], "once is coincidence");

    spend(db, account.id, "Swiggy", eatingOut.id, "2026-08-08");
    const proposals = proposeCategoryRules(db, actor);
    assert.equal(proposals.length, 1, "twice is a pattern");
    assert.equal(proposals[0]!.name, "Swiggy → Eating Out");
    assert.equal(proposals[0]!.stage, "default");
    db.close();
  });

  test("N9 — the proposal carries the reason it was inferred from", () => {
    const { db, account, eatingOut } = setup();
    spend(db, account.id, "Swiggy", eatingOut.id, "2026-08-01");
    spend(db, account.id, "Swiggy", eatingOut.id, "2026-08-08");
    proposeCategoryRules(db, actor);

    // Stored on the rule, not only in the event log: Review shows the sentence
    // next to the button that acts on it, so a guess never reads as a fact.
    const row = queryOne<{ because: string | null }>(
      db, `SELECT because FROM rules LIMIT 1`,
    )!;
    assert.equal(row.because, "You've put Swiggy in Eating Out 2 times.");
    db.close();
  });

  test("L3 — a proposal is never applied, only queued", () => {
    const { db, account, eatingOut } = setup();
    spend(db, account.id, "Swiggy", eatingOut.id, "2026-08-01");
    spend(db, account.id, "Swiggy", eatingOut.id, "2026-08-08");
    proposeCategoryRules(db, actor);

    const row = queryOne<{ proposed: number; enabled: number }>(
      db, `SELECT proposed, enabled FROM rules LIMIT 1`,
    )!;
    assert.equal(row.proposed, 1, "it sits in Review until confirmed");

    // An uncategorised transaction is left alone — the rule has not been used.
    const fresh = spend(db, account.id, "Swiggy", null, "2026-08-20");
    assert.equal(
      queryOne<{ category_id: string | null }>(
        db, `SELECT category_id FROM transactions WHERE id = ?`, fresh.id,
      )!.category_id,
      null,
    );
    db.close();
  });

  test("says why, so a suggestion is never unexplained", () => {
    const { db, account, groceries } = setup();
    for (const d of ["2026-08-01", "2026-08-08", "2026-08-15"]) {
      spend(db, account.id, "DMart", groceries.id, d);
    }
    const proposal = proposeCategoryRules(db, actor)[0]!;
    assert.equal(proposal.because, "You've put DMart in Groceries 3 times.");
    db.close();
  });

  test("does not propose the same rule twice", () => {
    const { db, account, eatingOut } = setup();
    spend(db, account.id, "Swiggy", eatingOut.id, "2026-08-01");
    spend(db, account.id, "Swiggy", eatingOut.id, "2026-08-08");

    assert.equal(proposeCategoryRules(db, actor).length, 1);
    assert.equal(proposeCategoryRules(db, actor).length, 0, "already proposed");
    db.close();
  });

  test("L5 — a dismissed proposal is suppressed permanently", () => {
    const { db, account, eatingOut } = setup();
    spend(db, account.id, "Swiggy", eatingOut.id, "2026-08-01");
    spend(db, account.id, "Swiggy", eatingOut.id, "2026-08-08");

    const payeeId = queryOne<{ id: string }>(db, `SELECT id FROM payees WHERE name = 'Swiggy'`)!.id;
    suppress(db, "learned-rule", `${payeeId}:${eatingOut.id}`, RAVI);
    execute(db, `DELETE FROM rules`);

    assert.deepEqual(proposeCategoryRules(db, actor), [], "never suggested again");
    db.close();
  });

  test("never proposes a card's payment category", () => {
    const { db, account } = setup();
    const card = createAccount(db, actor, {
      name: "HDFC Card", kind: "credit", subtype: "credit-card", openingDate: "2026-08-01",
    });
    const payment = queryOne<{ id: string }>(
      db, `SELECT id FROM categories WHERE payment_account_id = ?`, card.id,
    )!;

    spend(db, account.id, "Card payment", payment.id, "2026-08-01");
    spend(db, account.id, "Card payment", payment.id, "2026-08-08");

    // R6: that envelope is driven by the card's own transactions, so a rule
    // pointing at it would double-count.
    assert.deepEqual(proposeCategoryRules(db, actor), []);
    db.close();
  });

  test("L1 — renaming an imported payee proposes a pre-stage rule on the merchant", () => {
    const { db } = setup();
    const proposal = proposePayeeRule(db, actor, {
      rawNarration: "UPI/P2M/431202847592/SWIGGY*ORDER",
      cleanName: "Swiggy",
    })!;

    assert.equal(proposal.stage, "pre");
    // F6.9: matching the merchant keeps working when the order id changes.
    assert.deepEqual(proposal.conditions, [{ field: "merchant", op: "is", value: "Swiggy" }]);
    assert.match(proposal.because, /You renamed/);
    db.close();
  });

  test("falls back to the whole narration when there is no merchant to find", () => {
    const { db } = setup();
    const proposal = proposePayeeRule(db, actor, {
      rawNarration: "1234567890", cleanName: "Landlord",
    })!;
    assert.equal(proposal.conditions[0]!.field, "narration");
    db.close();
  });

  test("L4 — learning is disableable globally", () => {
    const { db } = setup();
    assert.equal(learningEnabled(db), true, "on by default");
    setLearningEnabled(db, actor, false);
    assert.equal(learningEnabled(db), false);
    setLearningEnabled(db, actor, true);
    assert.equal(learningEnabled(db), true);
    db.close();
  });
});

describe("F6.6 · retroactive apply", () => {
  const rule: Rule = {
    id: "r1", name: "Swiggy → Eating Out", stage: "default", match: "all",
    conditions: [{ field: "payee", op: "is", value: "Swiggy" }],
    actions: [{ type: "setCategory", categoryId: "REPLACED" }],
    enabled: true,
  };

  test("previews a count and what would change, before committing", () => {
    const { db, account, eatingOut, groceries } = setup();
    spend(db, account.id, "Swiggy", null, "2026-08-01");
    spend(db, account.id, "Swiggy", groceries.id, "2026-08-08");
    spend(db, account.id, "Swiggy", eatingOut.id, "2026-08-15");
    spend(db, account.id, "DMart", groceries.id, "2026-08-20");

    const preview = previewRetroactive(db, {
      ...rule, actions: [{ type: "setCategory", categoryId: eatingOut.id }],
    });

    assert.equal(preview.count, 3, "three Swiggy transactions match");
    assert.equal(preview.changing, 2, "one already agrees with the rule");
    assert.equal(preview.matches[0]!.proposedCategory, "Eating Out");

    // Nothing is written by a preview.
    assert.equal(
      queryOne<{ n: number }>(
        db, `SELECT COUNT(*) AS n FROM transactions WHERE category_id IS NULL`,
      )!.n,
      1,
    );
    db.close();
  });

  test("applies to matching transactions and attributes each change to the rule", () => {
    const { db, account, eatingOut, groceries } = setup();
    execute(
      db,
      `INSERT INTO rules (id,name,stage,conditions_json,actions_json,enabled,proposed,created_at)
       VALUES ('r1','Swiggy → Eating Out','default',?,?,1,0,?)`,
      JSON.stringify(rule.conditions),
      JSON.stringify([{ type: "setCategory", categoryId: eatingOut.id }]),
      nowIST(),
    );

    spend(db, account.id, "Swiggy", null, "2026-08-01");
    spend(db, account.id, "Swiggy", groceries.id, "2026-08-08");
    spend(db, account.id, "DMart", groceries.id, "2026-08-20");

    const changed = applyRetroactive(db, actor, {
      ...rule, actions: [{ type: "setCategory", categoryId: eatingOut.id }],
    });

    assert.equal(changed, 2);
    assert.equal(
      queryOne<{ n: number }>(
        db, `SELECT COUNT(*) AS n FROM transactions WHERE category_id = ?`, eatingOut.id,
      )!.n,
      2,
    );
    // DMart is untouched.
    assert.equal(
      queryOne<{ n: number }>(
        db, `SELECT COUNT(*) AS n FROM transactions WHERE category_id = ?`, groceries.id,
      )!.n,
      1,
    );

    // R-E4/F6.8: which rule touched it is recorded, and the event says so.
    assert.equal(
      queryAll<{ transaction_id: string }>(db, `SELECT * FROM rule_applications`).length, 2,
    );
    const events = queryAll<{ source: string; source_detail: string | null }>(
      db, `SELECT source, source_detail FROM events WHERE action = 'categorise'`,
    );
    assert.equal(events[0]!.source, "rule");
    assert.equal(events[0]!.source_detail, "Swiggy → Eating Out");
    db.close();
  });

  test("changes nothing when every match already agrees", () => {
    const { db, account, eatingOut } = setup();
    spend(db, account.id, "Swiggy", eatingOut.id, "2026-08-01");
    assert.equal(
      applyRetroactive(db, actor, {
        ...rule, actions: [{ type: "setCategory", categoryId: eatingOut.id }],
      }),
      0,
    );
    db.close();
  });
});

describe("04 §3.2 · import mapping profiles", () => {
  const HDFC = `Date,Narration,Chq./Ref.No.,Withdrawal Amt.,Deposit Amt.,Closing Balance
01-08-2026,SALARY,,,145000.00,145000.00
02-08-2026,UPI/DMART,431202,1450.00,,143550.00`;

  test("guesses a recognisable file without any saved profile", () => {
    const { db } = setup();
    const result = recognise(db, HDFC);
    assert.equal(result.kind, "guessed");
    if (result.kind !== "guessed") return;
    assert.equal(result.mapping.debit, 3);
    assert.equal(result.mapping.credit, 4);
    db.close();
  });

  test("recognises the same bank's file next month from the saved profile", () => {
    const { db, account } = setup();
    const first = recognise(db, HDFC);
    if (first.kind !== "guessed") throw new Error("expected a guess");

    saveProfile(db, actor, {
      name: "HDFC Savings", accountId: account.id,
      headers: first.headers, mapping: first.mapping,
    });

    const september = HDFC.replace(/-08-2026/g, "-09-2026");
    const second = recognise(db, september, account.id);
    assert.equal(second.kind, "profile");
    if (second.kind !== "profile") return;
    assert.equal(second.profile.name, "HDFC Savings");
    db.close();
  });

  test("an unrecognised file is a mapping task, not an error", () => {
    const { db } = setup();
    const result = recognise(db, "a;b;c\n1;2;3");
    assert.equal(result.kind, "unknown");
    if (result.kind !== "unknown") return;

    // The raw rows come back, which is what the mapping UI needs.
    assert.equal(result.rows.length, 2);
    assert.deepEqual(result.rows[0], ["a", "b", "c"]);
    db.close();
  });

  test("saving the same signature twice updates rather than duplicating", () => {
    const { db } = setup();
    const result = recognise(db, HDFC);
    if (result.kind !== "guessed") throw new Error("expected a guess");

    saveProfile(db, actor, { name: "HDFC", headers: result.headers, mapping: result.mapping });
    saveProfile(db, actor, { name: "HDFC renamed", headers: result.headers, mapping: result.mapping });

    const profiles = listProfiles(db);
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0]!.name, "HDFC renamed");
    db.close();
  });

  test("offers the columns with a sample value, so nothing is picked blind", () => {
    const { db } = setup();
    const result = recognise(db, HDFC);
    if (result.kind !== "guessed") throw new Error("expected a guess");

    const choices = columnChoices(result.rows, result.mapping.headerRow);
    assert.equal(choices[0]!.label, "Date");
    assert.equal(choices[0]!.sample, "01-08-2026");
    assert.equal(choices[3]!.label, "Withdrawal Amt.");
    db.close();
  });

  test("offers candidate header rows for a file where the header is buried", () => {
    const { db } = setup();
    const rows = recognise(
      db,
      `Statement of Account
Account: XXXX6612

Txn Date,Particulars,Debit,Credit
01-08-2026,SALARY,,145000.00`,
    );
    const candidates = candidateHeaderRows(rows.kind === "unknown" ? rows.rows : rows.rows);
    assert.ok(candidates.some((c) => c.cells.includes("Particulars")));
    db.close();
  });

  test("builds a mapping from what the user picked, and parses with it", () => {
    const { db } = setup();
    const text = `Txn Date|Particulars|Debit|Credit
01-08-2026|SALARY||145000.00
02-08-2026|RENT|41000.00|`;
    const result = recognise(db, text);

    const mapping = mappingFromSelections({
      headerRow: 0, date: 0, narration: 1, debit: 2, credit: 3,
    });
    assert.equal(validateMapping(mapping), null);

    const parsed = parseWith(result.rows, mapping);
    assert.equal(parsed.records.length, 2);
    assert.equal(parsed.records[0]!.amount, rupees(145_000));
    assert.equal(parsed.records[1]!.amount, rupees(-41_000));
    db.close();
  });

  test("explains what is missing rather than silently producing nothing", () => {
    assert.match(
      validateMapping({ headerRow: 0, date: -1, narration: 1 })!,
      /which column holds the date/,
    );
    assert.match(
      validateMapping({ headerRow: 0, date: 0, narration: 1 })!,
      /single amount column, or both a debit and a credit/,
    );
    assert.equal(
      validateMapping({ headerRow: 0, date: 0, narration: 1, amount: 2 }),
      null,
    );
  });

  test("prefers a debit/credit pair over a signed column when both exist", () => {
    const mapping = mappingFromSelections({
      headerRow: 0, date: 0, narration: 1, amount: 5, debit: 2, credit: 3,
    });
    assert.equal(mapping.debit, 2);
    assert.equal(mapping.amount, undefined);
  });

  test("does not use another account's profile", () => {
    const { db, account } = setup();
    const other = createAccount(db, actor, {
      name: "ICICI", kind: "budget", subtype: "savings", openingDate: "2026-08-01",
    });
    const result = recognise(db, HDFC);
    if (result.kind !== "guessed") throw new Error("expected a guess");

    saveProfile(db, actor, {
      name: "HDFC", accountId: account.id, headers: result.headers, mapping: result.mapping,
    });

    // Importing the same shape into a different account falls back to a guess.
    assert.equal(recognise(db, HDFC, other.id).kind, "guessed");
    void todayIST();
    db.close();
  });
});
