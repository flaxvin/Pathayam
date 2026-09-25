import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, queryOne, queryAll, newId, type DB } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import { createAccount } from "../domain/accounts.ts";
import { createGroup, createCategory } from "../domain/budget.ts";
import { createTransaction } from "../domain/transactions.ts";
import { parseStatement } from "./csv.ts";
import { ingest, listStaged, approveStaged, rejectStaged, mergeStaged, undoBatch } from "./pipeline.ts";
import { accountBalances, loadEngineInput } from "../engine/repository.ts";
import { computeBudget, identityResidual } from "../engine/engine.ts";
import { Missing, Refusal } from "../core/refusal.ts";

const RAVI = "m-ravi";
const actor: Actor = { memberId: RAVI, source: "ui" };

function setup() {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    RAVI, "ravi@example.com", "Ravi", nowIST());
  const account = createAccount(db, actor, {
    name: "HDFC Savings", kind: "budget", subtype: "savings", openingDate: "2026-08-01",
  });
  const group = createGroup(db, actor, "Flexible");
  const anyCategory = createCategory(db, actor, { groupId: group.id, name: "Everyday" }).id;
  return { db, account, group, anyCategory };
}

const STATEMENT = `Date,Narration,Chq./Ref.No.,Withdrawal Amt.,Deposit Amt.,Closing Balance
01-08-2026,NEFT-SALARY AUGUST,,,145000.00,145000.00
03-08-2026,UPI/P2M/431202847592/SWIGGY*ORDER,431202847592,450.00,,144550.00
05-08-2026,UPI/P2M/998877665544/DMART,998877665544,1450.50,,143099.50

Total,,,1900.50,145000.00,
This is a computer generated statement.`;

function importStatement(db: DB, accountId: string, text = STATEMENT, fileName = "hdfc-aug.csv") {
  const { result } = parseStatement(text);
  return ingest(db, actor, {
    accountId, source: "csv", adapter: "csv", fileName,
    records: result.records, errors: result.errors, rowsRead: result.rowsRead,
  });
}

describe("04 §2 · the pipeline", () => {
  test("stages every row for confirmation rather than posting to the ledger (I2)", () => {
    const { db, account } = setup();
    const outcome = importStatement(db, account.id);

    assert.equal(outcome.staged, 3);
    assert.equal(outcome.autoApproved, 0, "auto-approval is off by default");
    assert.equal(listStaged(db).length, 3);
    // Nothing has reached the ledger.
    assert.equal(queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM transactions`)!.n, 0);
    db.close();
  });

  test("I5 — re-importing the same file creates nothing new", () => {
    const { db, account, anyCategory } = setup();
    importStatement(db, account.id);
    for (const row of listStaged(db)) approveStaged(db, actor, row.id, { categoryId: anyCategory });

    const second = importStatement(db, account.id);
    assert.equal(second.staged, 0);
    assert.equal(second.skipped, 3);
    assert.equal(listStaged(db).length, 0, "and zero new review items");
    db.close();
  });

  test("retains the raw record unchanged alongside the transaction (P4, I1)", () => {
    const { db, account, anyCategory } = setup();
    importStatement(db, account.id);

    const swiggy = listStaged(db).find((r) => r.raw_narration?.includes("SWIGGY"))!;
    const txId = approveStaged(db, actor, swiggy.id, { categoryId: anyCategory });

    const tx = queryOne<{ raw_narration: string; raw_amount: string; raw_date: string | null }>(
      db, `SELECT raw_narration, raw_amount, raw_date FROM transactions WHERE id = ?`, txId,
    )!;
    assert.equal(tx.raw_narration, "UPI/P2M/431202847592/SWIGGY*ORDER");
    assert.equal(tx.raw_amount, "450.00");
    // Staged, then dropped by approveStaged: every approved row had NULL here.
    assert.equal(tx.raw_date, "03-08-2026");
    assertIdentity(db, "after approve");
    db.close();
  });

  test("proposes a payee from the narration without creating one (04 §3.6)", () => {
    const { db, account } = setup();
    importStatement(db, account.id);

    const swiggy = listStaged(db).find((r) => r.raw_narration?.includes("SWIGGY"))!;
    assert.equal(swiggy.proposed_payee, "Swiggy", "collapsed and title-cased");
    assert.equal(swiggy.payee_id, null, "a first-time merchant is a proposal, not an auto-created payee");
    assert.equal(queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM payees`)!.n, 0);
    db.close();
  });

  test("approving creates the payee and lands the transaction", () => {
    const { db, account, group } = setup();
    const eatingOut = createCategory(db, actor, { groupId: group.id, name: "Eating Out" });
    importStatement(db, account.id);

    const swiggy = listStaged(db).find((r) => r.raw_narration?.includes("SWIGGY"))!;
    approveStaged(db, actor, swiggy.id, { categoryId: eatingOut.id });

    const tx = queryOne<{ amount: number; category_id: string; cleared: number; payee_id: string }>(
      db, `SELECT * FROM transactions LIMIT 1`,
    )!;
    assert.equal(tx.amount, rupees(-450));
    assert.equal(tx.category_id, eatingOut.id);
    assert.equal(tx.cleared, 1, "D5 — statement import is how cleared gets set at scale");
    assert.ok(tx.payee_id);
    assert.equal(listStaged(db).length, 2);
    db.close();
  });

  test("signs a credit as income and a withdrawal as spending", () => {
    const { db, account, anyCategory } = setup();
    importStatement(db, account.id);
    for (const row of listStaged(db)) approveStaged(db, actor, row.id, { categoryId: anyCategory });

    assert.equal(accountBalances(db).get(account.id)!.working, rupees(143_099.5));
    db.close();
  });

  test("dismissing a row leaves the ledger untouched", () => {
    const { db, account } = setup();
    importStatement(db, account.id);
    const row = listStaged(db)[0]!;
    rejectStaged(db, actor, row.id);

    assert.equal(listStaged(db).length, 2);
    assert.equal(queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM transactions`)!.n, 0);
    db.close();
  });
});

describe("04 §4 · duplicates through the pipeline", () => {
  test("queues a manual entry against its imported twin rather than dropping either", () => {
    const { db, account, group } = setup();
    const eatingOut = createCategory(db, actor, { groupId: group.id, name: "Eating Out" });

    // Entered by hand at the counter, before the statement arrives.
    createTransaction(db, actor, {
      accountId: account.id, amount: rupees(-450), date: "2026-08-03",
      categoryId: eatingOut.id, payeeName: "Swiggy",
    });

    const outcome = importStatement(db, account.id);
    assert.equal(outcome.duplicates, 1);

    const flagged = listStaged(db).find((r) => r.duplicate_of_id !== null)!;
    assert.equal(flagged.duplicate_tier, "manual-vs-imported");
    assert.ok(flagged.duplicate_reason, "the match reason is stated, never just 'duplicate'");
    // N3 / I4: surfaced for a decision, not silently dropped.
    assert.equal(flagged.status, "pending");
    db.close();
  });

  test("merging keeps the manual category and adds the imported detail (D3, D4)", () => {
    const { db, account, group } = setup();
    const eatingOut = createCategory(db, actor, { groupId: group.id, name: "Eating Out" });
    const manual = createTransaction(db, actor, {
      accountId: account.id, amount: rupees(-450), date: "2026-08-03",
      categoryId: eatingOut.id, payeeName: "Swiggy",
    });

    importStatement(db, account.id);
    const flagged = listStaged(db).find((r) => r.duplicate_of_id !== null)!;
    mergeStaged(db, actor, flagged.id);

    const tx = queryOne<{
      category_id: string; cleared: number; raw_narration: string | null;
      raw_amount: string | null; raw_date: string | null;
    }>(
      db, `SELECT * FROM transactions WHERE id = ?`, manual.id,
    )!;
    assert.equal(tx.category_id, eatingOut.id, "the category you chose is kept");
    assert.equal(tx.cleared, 1, "and it is now known to have cleared");
    assert.match(tx.raw_narration!, /SWIGGY/, "with the bank's own string attached");
    // Merging copied narration and amount but not the date the bank printed.
    assert.equal(tx.raw_amount, "450.00");
    assert.equal(tx.raw_date, "03-08-2026");
    assertIdentity(db, "after merge");

    // Exactly one transaction, not two.
    assert.equal(queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM transactions WHERE deleted_at IS NULL`)!.n, 1);
    db.close();
  });

  test("keeping both is available and leaves two transactions (D2, H5)", () => {
    const { db, account, group } = setup();
    const eatingOut = createCategory(db, actor, { groupId: group.id, name: "Eating Out" });
    createTransaction(db, actor, {
      accountId: account.id, amount: rupees(-450), date: "2026-08-03",
      categoryId: eatingOut.id, payeeName: "Swiggy",
    });

    importStatement(db, account.id);
    const flagged = listStaged(db).find((r) => r.duplicate_of_id !== null)!;
    // Two people, same shop, same amount, same day is normal — approving is
    // one action with no friction.
    approveStaged(db, actor, flagged.id, { categoryId: eatingOut.id });

    assert.equal(queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM transactions WHERE deleted_at IS NULL`)!.n, 2);
    db.close();
  });
});

describe("F6 · rules through the pipeline", () => {
  function addRule(db: DB, categoryId: string, opts: { autoApprove?: boolean } = {}) {
    execute(
      db,
      `INSERT INTO rules (id,name,stage,conditions_json,actions_json,enabled,proposed,created_at)
       VALUES (?,?,?,?,?,1,0,?)`,
      newId(), "Swiggy → Eating Out", "default",
      JSON.stringify([{ field: "merchant", op: "is", value: "Swiggy" }]),
      JSON.stringify([
        { type: "setPayee", payee: "Swiggy" },
        { type: "setCategory", categoryId },
        ...(opts.autoApprove ? [{ type: "markAutoApprovable" }] : []),
      ]),
      nowIST(),
    );
  }

  test("proposes a category, still awaiting confirmation", () => {
    const { db, account, group } = setup();
    const eatingOut = createCategory(db, actor, { groupId: group.id, name: "Eating Out" });
    addRule(db, eatingOut.id);

    importStatement(db, account.id);
    const swiggy = listStaged(db).find((r) => r.raw_narration?.includes("SWIGGY"))!;

    assert.equal(swiggy.category_id, eatingOut.id);
    assert.equal(swiggy.status, "pending", "a rule proposes; a human confirms (N9, I2)");
    assert.ok(JSON.parse(swiggy.applied_rules_json!).length === 1, "which rule fired is recorded");
    db.close();
  });

  test("auto-approves only once a rule asks and a payee already exists (04 §6.5)", () => {
    const { db, account, group, anyCategory } = setup();
    const eatingOut = createCategory(db, actor, { groupId: group.id, name: "Eating Out" });
    addRule(db, eatingOut.id, { autoApprove: true });

    // First run: the payee does not exist yet, so the gate holds it back.
    const first = importStatement(db, account.id, STATEMENT, "aug.csv");
    assert.equal(first.autoApproved, 0, "auto-approval is earned per payee, not granted globally");

    for (const row of listStaged(db)) approveStaged(db, actor, row.id, { categoryId: anyCategory });

    // Second month: Swiggy is now a known payee, so the same rule lets it through.
    const september = STATEMENT.replace(/-08-2026/g, "-09-2026").replace(/431202847592/g, "551102847592");
    const second = importStatement(db, account.id, september, "sep.csv");
    assert.equal(second.autoApproved, 1);

    const auto = queryOne<{ auto_approved_at: string | null }>(
      db, `SELECT auto_approved_at FROM transactions WHERE auto_approved_at IS NOT NULL`,
    );
    assert.ok(auto, "and it stays visually marked in the register for its first 7 days");
    db.close();
  });

  test("an ignore rule keeps the row out entirely", () => {
    const { db, account } = setup();
    execute(
      db,
      `INSERT INTO rules (id,name,stage,conditions_json,actions_json,enabled,proposed,created_at)
       VALUES (?,?,?,?,?,1,0,?)`,
      newId(), "Never import salary", "pre",
      JSON.stringify([{ field: "narration", op: "contains", value: "SALARY" }]),
      JSON.stringify([{ type: "ignore" }]),
      nowIST(),
    );

    const outcome = importStatement(db, account.id);
    assert.equal(outcome.staged, 2);
    assert.equal(outcome.skipped, 1);
    db.close();
  });
});

describe("IL1, IL2 · the import log and batch undo", () => {
  test("records what the batch did", () => {
    const { db, account } = setup();
    const { batch } = importStatement(db, account.id);

    assert.equal(batch.file_name, "hdfc-aug.csv");
    assert.equal(batch.rows_read, 3);
    assert.equal(batch.created_count, 3);
    assert.equal(batch.error_count, 0, "footer rows are not errors");
    db.close();
  });

  test("undo removes what the batch created", () => {
    const { db, account, anyCategory } = setup();
    const { batch } = importStatement(db, account.id);
    for (const row of listStaged(db)) approveStaged(db, actor, row.id, { categoryId: anyCategory });

    const result = undoBatch(db, actor, batch.id);
    assert.equal(result.removed, 3);
    assert.equal(
      queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM transactions WHERE deleted_at IS NULL`)!.n,
      0,
    );
    db.close();
  });

  test("undo leaves anything edited since alone, and says so (IL2)", () => {
    const { db, account, group, anyCategory } = setup();
    const category = createCategory(db, actor, { groupId: group.id, name: "Eating Out" });
    const { batch } = importStatement(db, account.id);

    const rows = listStaged(db);
    const editedId = approveStaged(db, actor, rows[0]!.id, { categoryId: anyCategory });
    for (const row of rows.slice(1)) approveStaged(db, actor, row.id, { categoryId: anyCategory });

    // Someone categorised one of them before the undo.
    execute(db, `UPDATE transactions SET category_id = ?, updated_at = ? WHERE id = ?`,
      category.id, nowIST(), editedId);

    const result = undoBatch(db, actor, batch.id);
    assert.equal(result.removed, 2);
    assert.deepEqual(result.keptBecauseEdited, [editedId]);
    assert.ok(
      queryOne(db, `SELECT id FROM transactions WHERE id = ? AND deleted_at IS NULL`, editedId),
      "the edited record survives rather than being silently discarded",
    );
    db.close();
  });

  test("keeps parse errors with their offending rows (IL3)", () => {
    const { db, account } = setup();
    const broken = `Date,Narration,Withdrawal Amt.,Deposit Amt.
01-08-2026,SALARY,,145000.00
02-08-2026,MYSTERY,not-an-amount,`;
    const { batch } = importStatement(db, account.id, broken, "broken.csv");

    assert.equal(batch.error_count, 1);
    const errors = JSON.parse(
      queryOne<{ errors_json: string }>(db, `SELECT errors_json FROM import_batches WHERE id = ?`, batch.id)!
        .errors_json,
    );
    assert.ok(errors[0].cells.includes("MYSTERY"));
    db.close();
  });
});

describe("I5 · idempotency with rows still awaiting review", () => {
  test("re-importing produces zero new review items, not just zero transactions", () => {
    const { db, account } = setup();
    importStatement(db, account.id);
    assert.equal(listStaged(db).length, 3);

    // Nothing approved yet. Those rows are not in the ledger, so the
    // exact-match tier cannot see them — the queue itself has to be checked.
    const second = importStatement(db, account.id);

    assert.equal(second.staged, 0);
    assert.equal(second.skipped, 3);
    assert.equal(listStaged(db).length, 3, "the queue must not double");
    db.close();
  });

  test("catches a partially reviewed file too", () => {
    const { db, account, anyCategory } = setup();
    importStatement(db, account.id);
    approveStaged(db, actor, listStaged(db)[0]!.id, { categoryId: anyCategory });

    const second = importStatement(db, account.id);
    assert.equal(second.staged, 0);
    assert.equal(listStaged(db).length, 2);
    db.close();
  });

  test("renaming the downloaded file does not defeat it", () => {
    const { db, account } = setup();
    importStatement(db, account.id, STATEMENT, "statement.csv");

    // The same statement, saved under the name the household actually gave it.
    // A row's identity is what the row says, not what the file was called.
    const second = importStatement(db, account.id, STATEMENT, "hdfc-august-2026.csv");

    assert.equal(second.staged, 0);
    assert.equal(second.skipped, 3);
    assert.equal(listStaged(db).length, 3, "the queue must not double");
    db.close();
  });

  test("D2 · two genuinely identical rows both survive, and re-import skips both", () => {
    const { db, account } = setup();
    // Two people, same shop, same amount, same day (H5). Two rows in the file.
    const twice = `Date,Narration,Chq./Ref.No.,Withdrawal Amt.,Deposit Amt.,Closing Balance
04-08-2026,UPI/P2M/000000000001/CHAI POINT,,60.00,,143039.50
04-08-2026,UPI/P2M/000000000001/CHAI POINT,,60.00,,142979.50`;

    const first = importStatement(db, account.id, twice, "a.csv");
    assert.equal(first.staged, 2, "both must be kept — D2 forbids collapsing them");

    const second = importStatement(db, account.id, twice, "b.csv");
    assert.equal(second.staged, 0);
    assert.equal(second.skipped, 2);
    assert.equal(listStaged(db).length, 2);
    db.close();
  });
});

/** The budget identity, in every computed month. */
function assertIdentity(db: DB, when: string): void {
  const state = computeBudget(loadEngineInput(db, { through: "2026-09-30", useRollup: false }));
  for (const [month, s] of state) {
    assert.equal(identityResidual(s), 0, `identity broken in ${month} ${when}`);
  }
}

/*
 * A re-imported row could not be approved. approveStaged wrote every import
 * as source 'csv', and the unique index on (account_id, source, source_id)
 * also covers deleted rows, which the dedupe candidates skip. So: import 3
 * rows → approve → undo → re-import → approve was a UNIQUE-constraint 500,
 * and a PDF or email row imported twice was never recognised as exact and
 * 500'd the same way — on every Gmail fetch.
 */
describe("I5 · an exact repeat is recognised, never a 500", () => {
  test("import, approve, undo, re-import, approve", () => {
    const { db, account, anyCategory } = setup();
    const first = importStatement(db, account.id);
    for (const row of listStaged(db)) approveStaged(db, actor, row.id, { categoryId: anyCategory });
    assertIdentity(db, "after the first approval");
    undoBatch(db, actor, first.batch.id);
    assertIdentity(db, "after undo");

    const second = importStatement(db, account.id);
    assert.equal(second.staged, 3, "the undone rows are staged again");
    for (const row of listStaged(db)) approveStaged(db, actor, row.id, { categoryId: anyCategory });

    const live = queryAll<{ amount: number }>(
      db, `SELECT amount FROM transactions WHERE account_id = ? AND deleted_at IS NULL`, account.id,
    );
    assert.equal(live.length, 3);
    assert.equal(accountBalances(db).get(account.id)!.working, rupees(143_099.5));
    assertIdentity(db, "after re-approval");
    db.close();
  });

  test("a PDF row approved once is skipped when the statement is imported again", () => {
    const { db, account, anyCategory } = setup();
    const { result } = parseStatement(STATEMENT);
    const again = () => ingest(db, actor, {
      accountId: account.id, source: "pdf", adapter: "hdfc", fileName: "hdfc.pdf",
      records: result.records, errors: result.errors, rowsRead: result.rowsRead,
    });
    again();
    for (const row of listStaged(db)) approveStaged(db, actor, row.id, { categoryId: anyCategory });
    const sources = queryAll<{ source: string }>(db, `SELECT DISTINCT source FROM transactions`);
    assert.deepEqual(sources.map((s) => s.source), ["pdf"], "approval keeps the row's own source");

    const second = again();
    assert.equal(second.staged, 0);
    assert.equal(second.skipped, 3);
    assertIdentity(db, "after the second import");
    db.close();
  });

  test("a row already in the ledger under an old 'csv' source is matched, not added", () => {
    const { db, account, anyCategory } = setup();
    const { result } = parseStatement(STATEMENT);
    ingest(db, actor, {
      accountId: account.id, source: "email", adapter: "axis-alert",
      records: result.records.slice(1, 2), rowsRead: 1,
    });
    const [row] = listStaged(db);
    // What an approval wrote before this fix: the same identity, source 'csv'.
    const old = createTransaction(db, actor, {
      accountId: account.id, amount: row!.amount, date: row!.date, categoryId: anyCategory,
      source: "csv", sourceId: row!.source_id,
    });

    const id = approveStaged(db, actor, row!.id, { categoryId: anyCategory });
    assert.equal(id, old.id);
    assert.equal(queryAll(db, `SELECT id FROM transactions WHERE deleted_at IS NULL`).length, 1);
    assert.equal(
      queryOne<{ status: string }>(db, `SELECT status FROM staged_transactions WHERE id = ?`, row!.id)!.status,
      "merged",
    );
    assertIdentity(db, "after matching");
    db.close();
  });
});

/*
 * The queue acted on whatever id it was given. Approve the ₹450 Swiggy row,
 * then merge it into the manual twin: both transactions stayed (₹450 twice)
 * and the screen said "Merged". Reject after approve flipped the row to
 * rejected with its transaction still in the ledger. A made-up staged id or
 * batch id reported success.
 */
describe("the review queue only acts on items still waiting", () => {
  test("merging a row already approved is refused, and the ledger keeps one ₹450", () => {
    const { db, account, group } = setup();
    const eatingOut = createCategory(db, actor, { groupId: group.id, name: "Eating Out" });
    createTransaction(db, actor, {
      accountId: account.id, amount: rupees(-450), date: "2026-08-03",
      categoryId: eatingOut.id, payeeName: "Swiggy",
    });
    importStatement(db, account.id);
    const flagged = listStaged(db).find((r) => r.duplicate_of_id !== null)!;
    approveStaged(db, actor, flagged.id, { categoryId: eatingOut.id });
    assertIdentity(db, "after approve");

    assert.throws(() => mergeStaged(db, actor, flagged.id), Refusal);
    assert.throws(() => rejectStaged(db, actor, flagged.id), Refusal);
    const status = queryOne<{ status: string }>(
      db, `SELECT status FROM staged_transactions WHERE id = ?`, flagged.id,
    )!.status;
    assert.equal(status, "approved", "a refused reject does not flip the row");
    assertIdentity(db, "after the refused merge");
    db.close();
  });

  test("an id that names nothing is Missing, not a success", () => {
    const { db } = setup();
    assert.throws(() => rejectStaged(db, actor, "no-such-row"), Missing);
    assert.throws(() => mergeStaged(db, actor, "no-such-row"), Missing);
    assert.throws(() => undoBatch(db, actor, "no-such-batch"), Missing);
    db.close();
  });

  test("a batch cannot be undone twice", () => {
    const { db, account } = setup();
    const first = importStatement(db, account.id);
    undoBatch(db, actor, first.batch.id);
    assert.throws(() => undoBatch(db, actor, first.batch.id), Refusal);
    db.close();
  });
});
