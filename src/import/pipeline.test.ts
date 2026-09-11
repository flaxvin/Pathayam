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
import { accountBalances } from "../engine/repository.ts";

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

    const tx = queryOne<{ raw_narration: string; raw_amount: string }>(
      db, `SELECT raw_narration, raw_amount FROM transactions WHERE id = ?`, txId,
    )!;
    assert.equal(tx.raw_narration, "UPI/P2M/431202847592/SWIGGY*ORDER");
    assert.equal(tx.raw_amount, "450.00");
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

    const tx = queryOne<{ category_id: string; cleared: number; raw_narration: string | null }>(
      db, `SELECT * FROM transactions WHERE id = ?`, manual.id,
    )!;
    assert.equal(tx.category_id, eatingOut.id, "the category you chose is kept");
    assert.equal(tx.cleared, 1, "and it is now known to have cleared");
    assert.match(tx.raw_narration!, /SWIGGY/, "with the bank's own string attached");

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
