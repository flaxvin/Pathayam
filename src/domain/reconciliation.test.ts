import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, queryOne, type DB } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { queryEvents } from "../core/events.ts";
import { nowIST, addDays, todayIST } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import { createAccount } from "./accounts.ts";
import { createGroup, createCategory, setAssigned } from "./budget.ts";
import { createTransaction, updateTransaction, deleteTransaction } from "./transactions.ts";
import {
  reconcile, previewReconciliation, clearedBalanceAsOf, checkpointsAffectedBy,
  guardHistoricalEdit, editReconciledHistory, reconciliationStatus, brokenCheckpoints,
  CheckpointConfirmationRequired,
} from "./reconciliation.ts";

const RAVI = "m-ravi";
const actor: Actor = { memberId: RAVI, source: "ui" };

function setup() {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    RAVI, "ravi@example.com", "Ravi", nowIST());
  const account = createAccount(db, actor, {
    name: "HDFC Savings", kind: "budget", subtype: "savings",
    openingBalance: rupees(100_000), openingDate: "2026-08-01",
  });
  const group = createGroup(db, actor, "Flexible");
  const groceries = createCategory(db, actor, { groupId: group.id, name: "Groceries" });
  return { db, account, groceries };
}

describe("F9.1 · the difference", () => {
  test("compares the bank's balance to the app's cleared balance", () => {
    const { db, account, groceries } = setup();
    createTransaction(db, actor, {
      accountId: account.id, amount: rupees(-5_000), date: "2026-08-10",
      categoryId: groceries.id, cleared: true,
    });
    // Uncleared: has not reached the bank, so it cannot be part of the assertion.
    createTransaction(db, actor, {
      accountId: account.id, amount: rupees(-840), date: "2026-08-24", categoryId: groceries.id,
    });

    assert.equal(clearedBalanceAsOf(db, account.id, "2026-08-25"), rupees(95_000));

    // J8: bank says ₹1,24,380 → here, ₹95,000 cleared, so ₹840 unaccounted.
    const preview = previewReconciliation(db, account.id, rupees(95_840), "2026-08-25");
    assert.equal(preview.difference, rupees(840));
    assert.equal(preview.balances, false);
    assert.equal(preview.uncleared.length, 1);
    assert.equal(preview.uncleared[0]!.amount, rupees(-840));
    db.close();
  });

  test("excludes transactions dated after the reconciliation date", () => {
    const { db, account, groceries } = setup();
    createTransaction(db, actor, {
      accountId: account.id, amount: rupees(-5_000), date: "2026-08-30",
      categoryId: groceries.id, cleared: true,
    });
    assert.equal(clearedBalanceAsOf(db, account.id, "2026-08-25"), rupees(100_000));
    db.close();
  });
});

describe("F9.2 · resolving a mismatch", () => {
  test("J8 — ticking the uncleared item balances it and locks a checkpoint", () => {
    const { db, account, groceries } = setup();
    const uncleared = createTransaction(db, actor, {
      accountId: account.id, amount: rupees(-840), date: "2026-08-24", categoryId: groceries.id,
    });

    const result = reconcile(db, actor, {
      accountId: account.id,
      bankBalance: rupees(99_160),
      asOf: "2026-08-25",
      clearTransactionIds: [uncleared.id],
    });

    assert.equal(result.status, "reconciled");
    assert.equal(result.status === "reconciled" ? result.adjustment : -1, 0);
    assert.equal(
      queryOne<{ cleared: number }>(db, `SELECT cleared FROM transactions WHERE id = ?`, uncleared.id)!.cleared,
      1,
    );
    db.close();
  });

  test("refuses to invent an adjustment the user has not seen", () => {
    const { db, account } = setup();
    const result = reconcile(db, actor, {
      accountId: account.id, bankBalance: rupees(99_000), asOf: "2026-08-25",
    });

    assert.equal(result.status, "needs-decision");
    assert.equal(result.status === "needs-decision" ? result.preview.difference : 0, rupees(-1_000));
    // Nothing written until the user decides.
    assert.equal(queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM reconciliations`)!.n, 0);
    db.close();
  });

  test("writes a balancing adjustment once accepted, categorised so it is visible", () => {
    const { db, account } = setup();
    const result = reconcile(db, actor, {
      accountId: account.id, bankBalance: rupees(99_000), asOf: "2026-08-25",
      allowAdjustment: true,
    });

    assert.equal(result.status, "reconciled");
    const adjustment = queryOne<{ amount: number; category_id: string; memo: string }>(
      db, `SELECT * FROM transactions WHERE memo LIKE 'Reconciliation adjustment%'`,
    )!;
    assert.equal(adjustment.amount, rupees(-1_000));
    assert.ok(adjustment.category_id, "never uncategorised, so it cannot hide");
    assert.equal(clearedBalanceAsOf(db, account.id, "2026-08-25"), rupees(99_000));
    db.close();
  });
});

describe("09 §5 · R7.a to R7.f — editing reconciled history", () => {
  function reconciled(db: DB, accountId: string, asOf = "2026-08-25") {
    const result = reconcile(db, actor, {
      accountId, bankBalance: clearedBalanceAsOf(db, accountId, asOf), asOf,
    });
    assert.equal(result.status, "reconciled");
    return result.status === "reconciled" ? result.checkpoint : null!;
  }

  test("R7.a — there is no hard freeze; the edit is allowed once confirmed", () => {
    const { db, account, groceries } = setup();
    const t = createTransaction(db, actor, {
      accountId: account.id, amount: rupees(-5_000), date: "2026-08-10",
      categoryId: groceries.id, cleared: true,
    });
    reconciled(db, account.id);

    const broken = editReconciledHistory(db, actor, {
      accountId: account.id, date: "2026-08-10", confirmed: true,
      reason: "an amount was changed",
    });
    updateTransaction(db, actor, t.id, { amount: rupees(-6_000) });

    assert.equal(broken, 1);
    assert.equal(
      queryOne<{ amount: number }>(db, `SELECT amount FROM transactions WHERE id = ?`, t.id)!.amount,
      rupees(-6_000),
      "the edit went through — Q5 asked for exactly this",
    );
    db.close();
  });

  test("R7.b — the edit requires explicit confirmation naming the checkpoint", () => {
    const { db, account, groceries } = setup();
    createTransaction(db, actor, {
      accountId: account.id, amount: rupees(-5_000), date: "2026-08-10",
      categoryId: groceries.id, cleared: true,
    });
    reconciled(db, account.id, "2026-08-25");

    try {
      guardHistoricalEdit(db, account.id, "2026-08-10", false);
      assert.fail("should have demanded confirmation");
    } catch (err) {
      assert.ok(err instanceof CheckpointConfirmationRequired);
      // The message names the checkpoint and its date, not just "are you sure".
      assert.match(err.message, /25-08-2026/);
      assert.match(err.message, /HDFC Savings/);
      assert.equal(err.checkpoints.length, 1);
    }
    db.close();
  });

  test("R7.c — the checkpoint is marked broken, not repaired", () => {
    const { db, account, groceries } = setup();
    createTransaction(db, actor, {
      accountId: account.id, amount: rupees(-5_000), date: "2026-08-10",
      categoryId: groceries.id, cleared: true,
    });
    reconciled(db, account.id);

    editReconciledHistory(db, actor, {
      accountId: account.id, date: "2026-08-10", confirmed: true, reason: "an amount was changed",
    });

    const status = reconciliationStatus(db, account.id, "2026-08-26");
    assert.equal(status.broken, true);
    assert.equal(status.lastReconciled, "2026-08-25", "the date is still shown — 'reconciled, changed since'");
    assert.match(status.brokenReason!, /amount was changed/);
    db.close();
  });

  test("R7.d — it appears in Review until resolved", () => {
    const { db, account, groceries } = setup();
    createTransaction(db, actor, {
      accountId: account.id, amount: rupees(-5_000), date: "2026-08-10",
      categoryId: groceries.id, cleared: true,
    });
    reconciled(db, account.id);
    editReconciledHistory(db, actor, {
      accountId: account.id, date: "2026-08-10", confirmed: true, reason: "an amount was changed",
    });

    assert.equal(brokenCheckpoints(db).length, 1);
    assert.equal(brokenCheckpoints(db)[0]!.account_name, "HDFC Savings");

    // Reconciling again is what resolves it — a fresh, intact checkpoint.
    reconciled(db, account.id, "2026-08-27");
    assert.equal(reconciliationStatus(db, account.id, "2026-08-27").broken, false);
    assert.equal(brokenCheckpoints(db).length, 1, "the broken one stays in the log, it is not erased");
    db.close();
  });

  test("R7.e — both values are recorded in the event log", () => {
    const { db, account, groceries } = setup();
    createTransaction(db, actor, {
      accountId: account.id, amount: rupees(-5_000), date: "2026-08-10",
      categoryId: groceries.id, cleared: true,
    });
    const checkpoint = reconciled(db, account.id);
    editReconciledHistory(db, actor, {
      accountId: account.id, date: "2026-08-10", confirmed: true, reason: "an amount was changed",
    });

    const event = queryEvents(db, { entity: "reconciliation", action: "break" })[0]!;
    const before = event.before as { bankBalance: number; broken: boolean };
    assert.equal(before.bankBalance, checkpoint.bank_balance);
    assert.equal(before.broken, false);
    assert.equal((event.after as { broken: boolean }).broken, true);
    db.close();
  });

  test("R7.f — a later edit does not silently un-break or re-assert it", () => {
    const { db, account, groceries } = setup();
    createTransaction(db, actor, {
      accountId: account.id, amount: rupees(-5_000), date: "2026-08-10",
      categoryId: groceries.id, cleared: true,
    });
    reconciled(db, account.id);
    editReconciledHistory(db, actor, {
      accountId: account.id, date: "2026-08-10", confirmed: true, reason: "edited",
    });

    // Even restoring the original figure leaves it broken. Only reconciling
    // again asserts the balance, because only a human can do that.
    editReconciledHistory(db, actor, {
      accountId: account.id, date: "2026-08-10", confirmed: true, reason: "changed back",
    });
    assert.equal(reconciliationStatus(db, account.id).broken, true);
    db.close();
  });

  test("an edit after the checkpoint needs no confirmation at all", () => {
    const { db, account } = setup();
    reconciled(db, account.id, "2026-08-25");
    // Dated after the assertion, so the assertion is untouched.
    assert.deepEqual(checkpointsAffectedBy(db, account.id, "2026-08-26"), []);
    assert.doesNotThrow(() => guardHistoricalEdit(db, account.id, "2026-08-26", false));
    db.close();
  });

  test("deleting a reconciled transaction breaks the checkpoint too", () => {
    const { db, account, groceries } = setup();
    const t = createTransaction(db, actor, {
      accountId: account.id, amount: rupees(-5_000), date: "2026-08-10",
      categoryId: groceries.id, cleared: true,
    });
    reconciled(db, account.id);

    editReconciledHistory(db, actor, {
      accountId: account.id, date: "2026-08-10", confirmed: true, reason: "a transaction was deleted",
    });
    deleteTransaction(db, actor, t.id);

    assert.equal(reconciliationStatus(db, account.id).broken, true);
    db.close();
  });

  test("an already-broken checkpoint is not asked about twice", () => {
    const { db, account, groceries } = setup();
    createTransaction(db, actor, {
      accountId: account.id, amount: rupees(-5_000), date: "2026-08-10",
      categoryId: groceries.id, cleared: true,
    });
    reconciled(db, account.id);
    editReconciledHistory(db, actor, {
      accountId: account.id, date: "2026-08-10", confirmed: true, reason: "first edit",
    });

    // It is already broken, so there is nothing left to protect and no reason
    // to interrupt again.
    assert.deepEqual(checkpointsAffectedBy(db, account.id, "2026-08-10"), []);
    assert.doesNotThrow(() => guardHistoricalEdit(db, account.id, "2026-08-10", false));
    db.close();
  });

  test("changing a past-month assignment does not break an account checkpoint", () => {
    const { db, account, groceries } = setup();
    reconciled(db, account.id, "2026-08-25");

    // An assignment moves money between envelopes. Every account balance is
    // unchanged, so the bank's assertion is still true. Breaking here would
    // fire constantly with nothing wrong — see the note at the top of
    // reconciliation.ts for why this narrows 09 §5's wording.
    setAssigned(db, actor, "2026-08", groceries.id, rupees(9_000));

    assert.equal(reconciliationStatus(db, account.id, "2026-08-26").broken, false);
    db.close();
  });

  test("only the affected account is guarded", () => {
    const { db, account, groceries } = setup();
    const other = createAccount(db, actor, {
      name: "ICICI", kind: "budget", subtype: "savings", openingDate: "2026-08-01",
    });
    reconciled(db, account.id, "2026-08-25");

    assert.deepEqual(checkpointsAffectedBy(db, other.id, "2026-08-10"), []);
    void groceries;
    db.close();
  });
});

describe("F9.4 · status", () => {
  test("counts days since the last reconciliation and nudges monthly", () => {
    const { db, account } = setup();
    reconcile(db, actor, {
      accountId: account.id, bankBalance: rupees(100_000), asOf: "2026-08-01",
    });

    assert.equal(reconciliationStatus(db, account.id, "2026-08-15").daysSince, 14);
    assert.equal(reconciliationStatus(db, account.id, "2026-08-15").shouldNudge, false);
    assert.equal(reconciliationStatus(db, account.id, "2026-09-05").shouldNudge, true);
    db.close();
  });

  test("nudges an account that has never been reconciled", () => {
    const { db, account } = setup();
    const status = reconciliationStatus(db, account.id);
    assert.equal(status.lastReconciled, null);
    assert.equal(status.shouldNudge, true);
    void addDays(todayIST(), 0);
    db.close();
  });
});
