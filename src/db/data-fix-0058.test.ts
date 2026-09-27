/**
 * 0058 · a loan that chose to keep its instalment has it stored.
 *
 * Replays only 0058 over loans recorded the way the app wrote them before it:
 * the choice is in the events, and the instalment has to be recovered.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execute, queryOne, migrate, type DB } from "./db.ts";
import { MIGRATIONS } from "./schema.ts";
import { freshDb } from "../web/harness.test-data.ts";
import { undoEvent, type Actor } from "../core/events.ts";
import { todayIST } from "../core/dates.ts";
import { rupees, type Paise } from "../core/money.ts";
import { createAccount } from "../domain/accounts.ts";
import { createLoan, recordInstalment, recordPrepayment, recordRateChange } from "../domain/loans.ts";

const actor: Actor = { memberId: "m", source: "ui" };

function loan(db: DB, bank: string, tenureMonths = 12): string {
  return createLoan(db, actor, {
    lender: "Fictional Bank", loanType: "personal", sanctioned: rupees(1_00_000),
    sanctionDate: "2025-01-01", interestModel: "reducing", annualRatePct: 12,
    tenureMonths, currentOutstanding: rupees(1_00_000), repaymentAccountId: bank,
  }).id;
}

const pin = (db: DB, id: string) =>
  queryOne<{ emi_pinned: number | null }>(db, `SELECT emi_pinned FROM loans WHERE id = ?`, id)!.emi_pinned;

describe("0058 · a kept instalment is stored", () => {
  test("recovered from the last instalment paid, or priced from the loan; other choices pin nothing", () => {
    const db = freshDb();
    execute(db, `INSERT INTO members (id,email,name,created_at) VALUES ('m','ravi@example.com','Ravi','2025-01-01T00:00:00+05:30')`);
    const bank = createAccount(db, actor, {
      name: "Bank", kind: "budget", subtype: "savings",
      openingDate: "2025-01-01", openingBalance: rupees(10_00_000),
    }).id;
    const prepay = (id: string, mode: "tenure" | "emi", date = "2025-01-10") =>
      recordPrepayment(db, actor, { loanId: id, date, amount: rupees(10_000) as Paise, mode });

    const priced = loan(db, bank);
    prepay(priced, "tenure");

    const paid = loan(db, bank);
    recordInstalment(db, actor, { loanId: paid, date: "2025-02-05", amount: rupees(9_000) as Paise, fromAccountId: bank });
    prepay(paid, "tenure", "2025-02-10");

    const movedLater = loan(db, bank);
    prepay(movedLater, "tenure");
    prepay(movedLater, "emi", "2025-01-12");

    const undone = loan(db, bank);
    prepay(undone, "tenure");
    const ev = queryOne<{ id: string }>(db,
      `SELECT id FROM events WHERE entity = 'loan' AND entity_id = ? AND action = 'instalment'`, undone)!.id;
    assert.ok(undoEvent(db, ev, actor, { force: true }).ok);

    const rate = loan(db, bank, 24);
    recordRateChange(db, actor, { loanId: rate, effectiveFrom: todayIST(), annualRatePct: 14, keep: "emi" });

    const untouched = loan(db, bank);

    // Back to how the app left them before 0058.
    db.exec(`ALTER TABLE loans DROP COLUMN emi_pinned`);
    db.exec(`ALTER TABLE loans DROP COLUMN emi_pinned_until`);
    db.exec("PRAGMA user_version = 57");
    migrate(db, false, 58);
    db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);

    assert.equal(pin(db, priced), 888488, "₹1,00,000 at 12% over 12 months");
    assert.equal(pin(db, paid), rupees(9_000), "the instalment actually paid before the choice");
    assert.equal(pin(db, movedLater), null);
    assert.equal(pin(db, undone), null);
    assert.equal(pin(db, rate), 470735, "₹1,00,000 at 12% over 24 months, before the rise");
    assert.equal(pin(db, untouched), null);
  });
});
