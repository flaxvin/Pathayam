/**
 * Every screen, as two different people, diffed.
 *
 * Six privacy leaks were found in two days and every one had the same shape: a
 * surface that reads the whole household's data and shows it to one person. The
 * account list, net worth and the loans page had been fixed once. Then
 * `queryTransactions` had not, and Query, Search, the CSV export and the whole
 * reports page were printing one member's private spending line by line. Then
 * the category pickers had not, and five screens offered another member's
 * private envelopes by name. Then the write side had not, and posting the id by
 * hand still worked. Then the rule proposals had not — "You've put Blinkist in
 * Books and courses 36 times" — and then the Rules screen had not either.
 *
 * Each fix was correct. Each was found by hand, by signing in as somebody else
 * and looking. This does that: it plants strings that exist nowhere else in the
 * household, renders every screen as the member who cannot see them, and fails
 * if any of them appears.
 *
 * The point is that it needs no list of screens to keep in step with the app —
 * the route table is the list. A screen added tomorrow is swept tomorrow.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { freshDb, seedMember, startTestApp, type TestApp } from "./harness.test-data.ts";
import { execute } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { rupees, type Paise } from "../core/money.ts";
import { todayIST, nowIST } from "../core/dates.ts";
import { createAccount } from "../domain/accounts.ts";
import { createGroup, createCategory, setAssigned } from "../domain/budget.ts";
import { createTransaction } from "../domain/transactions.ts";
import { createLoan } from "../domain/loans.ts";
import { createFamilyLoan, recordAdvance } from "../domain/family-loans.ts";
import { ensurePersonalBudget } from "../domain/budgets.ts";
import { monthOf } from "../core/dates.ts";
import { reviewCount } from "./viewmodel.ts";

const RAVI = "m-ravi";
const PRIYA = "m-priya";
const ravi: Actor = { memberId: RAVI, source: "ui" };

/**
 * Strings that exist nowhere else in the household, one per private thing, so a
 * match in somebody else's HTML is unambiguous — no false positive from a
 * shared word, and the failure message says exactly which thing leaked.
 */
const SECRETS = {
  account: "Zzyzx Private Account",
  envelope: "Qwertyuiop Envelope",
  payee: "Vantablack Merchant",
  loan: "Xylophone Finance",
  arrangement: "Pennyfarthing Cousin",
  unfiled: "Okapi Unfiled Payee",
  statementLine: "Narwhal Statement Narration",
  statementFile: "Axolotl-statement.pdf",
} as const;

let app: TestApp;
let paths: string[];
let visibleOfHisId: string;

before(async () => {
  const db = freshDb();
  seedMember(db, RAVI, "Ravi");
  seedMember(db, PRIYA, "Priya");

  // The household's own money, so the screens have something ordinary to show.
  const joint = createAccount(db, ravi, {
    name: "Joint current", kind: "budget", subtype: "savings",
    openingDate: "2026-01-01", openingBalance: rupees(2_00_000),
  });
  const shared = createGroup(db, ravi, "Everyday");
  const groceries = createCategory(db, ravi, { groupId: shared.id, name: "Groceries" });
  setAssigned(db, ravi, monthOf(todayIST()), groceries.id, rupees(20_000) as Paise);
  createTransaction(db, ravi, {
    accountId: joint.id, amount: -rupees(1_200) as Paise, date: todayIST(),
    categoryId: groceries.id, payeeName: "DMart", cleared: true, ownerMemberId: RAVI,
  });

  // And Ravi's own, every kind of private thing the app has.
  const his = ensurePersonalBudget(db, RAVI, "Ravi");
  const secretAccount = createAccount(db, ravi, {
    name: SECRETS.account, kind: "budget", subtype: "savings",
    openingDate: "2026-01-01", openingBalance: rupees(3_00_000),
    holderMemberId: RAVI, visibility: "private", budgetId: his.id,
  });
  const hisGroup = createGroup(db, ravi, "Mine", "normal", his.id);
  const secretEnvelope = createCategory(db, ravi, {
    groupId: hisGroup.id, name: SECRETS.envelope,
  });
  setAssigned(db, ravi, monthOf(todayIST()), secretEnvelope.id, rupees(9_000) as Paise);
  createTransaction(db, ravi, {
    accountId: secretAccount.id, amount: -rupees(4_321) as Paise, date: todayIST(),
    categoryId: secretEnvelope.id, payeeName: SECRETS.payee, cleared: true, ownerMemberId: RAVI,
  });

  createLoan(db, ravi, {
    lender: SECRETS.loan, loanType: "personal", sanctioned: rupees(1_00_000),
    sanctionDate: "2026-01-01", interestModel: "reducing", annualRatePct: 13,
    tenureMonths: 24, currentOutstanding: rupees(1_00_000),
    repaymentAccountId: secretAccount.id, holderMemberId: RAVI, visibility: "private",
  });

  const arrangement = createFamilyLoan(db, ravi, {
    counterparty: SECRETS.arrangement, holderMemberId: RAVI, visibility: "private",
  });
  recordAdvance(db, ravi, {
    loanId: arrangement.id, amount: rupees(5_000) as Paise, date: todayIST(),
    fromAccountId: secretAccount.id,
  });

  /*
   * The review queue's own lists. Each read the whole household: an unfiled
   * expense, a reimbursable one, a statement line waiting for approval and a
   * broken reconciliation on Ravi's private account were all on Priya's
   * /review, by payee, narration and account name.
   */
  execute(
    db,
    `INSERT INTO transactions (id,account_id,date,amount,payee_id,category_id,is_split,cleared,
       owner_member_id,reimbursable,source,created_at,created_by,updated_at)
     VALUES ('tx-secret-unfiled',?,?,?,NULL,NULL,0,0,?,1,'manual',?,?,?)`,
    secretAccount.id, todayIST(), -rupees(777), RAVI, nowIST(), RAVI, nowIST(),
  );
  execute(db, `INSERT INTO payees (id,name,created_at) VALUES ('payee-secret-unfiled',?,?)`,
    SECRETS.unfiled, nowIST());
  execute(db, `UPDATE transactions SET payee_id = 'payee-secret-unfiled' WHERE id = 'tx-secret-unfiled'`);
  execute(
    db,
    `INSERT INTO import_batches (id,source,adapter,account_id,file_name,member_id,created_at)
     VALUES ('batch-secret','file','csv',?,?,?,?)`,
    secretAccount.id, SECRETS.statementFile, RAVI, nowIST(),
  );
  execute(
    db,
    `INSERT INTO staged_transactions (id,batch_id,account_id,date,amount,raw_narration,status,created_at)
     VALUES ('staged-secret','batch-secret',?,?,?,?,'pending',?)`,
    secretAccount.id, todayIST(), -rupees(333), SECRETS.statementLine, nowIST(),
  );
  execute(
    db,
    `INSERT INTO reconciliations (id,account_id,as_of,bank_balance,app_balance,created_at,
       created_by,broken_at,broken_reason)
     VALUES ('recon-secret',?,?,0,0,?,?,?,'edited')`,
    secretAccount.id, todayIST(), nowIST(), RAVI, nowIST(),
  );

  /*
   * An account of Ravi's the household may see, in his own budget, whose
   * spending is filed to his private envelope. The account is visible; the
   * envelope is not, and memberScope hides every transaction filed to it.
   */
  const visibleOfHis = createAccount(db, ravi, {
    name: "Ravi's shared savings", kind: "budget", subtype: "savings",
    openingDate: "2026-01-01", openingBalance: rupees(50_000),
    holderMemberId: RAVI, budgetId: his.id,
  });
  visibleOfHisId = visibleOfHis.id;
  createTransaction(db, ravi, {
    accountId: visibleOfHis.id, amount: -rupees(1_234) as Paise, date: todayIST(),
    categoryId: secretEnvelope.id, payeeName: "Cafe", cleared: true, ownerMemberId: RAVI,
  });

  // A rule about the private envelope, which is how the learning feature leaked.
  execute(
    db,
    `INSERT INTO rules (id,name,stage,conditions_json,actions_json,enabled,proposed,created_at)
     VALUES (?,?,?,?,?,1,1,?)`,
    "rule-secret", `${SECRETS.payee} → ${SECRETS.envelope}`, "default",
    JSON.stringify([{ field: "narration", op: "contains", value: SECRETS.payee }]),
    JSON.stringify([{ type: "setCategory", categoryId: secretEnvelope.id }]),
    nowIST(),
  );

  // Priya is looking. She can see none of the above.
  app = await startTestApp(db, { memberId: PRIYA });
  paths = sweepablePaths();
});

after(async () => {
  assert.deepEqual(app.failures, [], "a screen 500ed during the sweep");
  await app.close();
});

/**
 * Every GET route the app serves that renders a page for a person, taken from
 * the router itself so the list cannot fall behind. Parameterised routes are
 * left out: they address one thing, and a thing Priya cannot see answers
 * not-found anyway — which `privacy-by-url.test.ts` checks directly.
 */
function sweepablePaths(): string[] {
  const app = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "app.ts"), "utf8",
  );
  const skip = new Set([
    "/signin", "/signout", "/auth/google", "/auth/google/callback", "/gmail/callback",
    "/gmail/connect", "/healthz", "/export.csv", "/export.json", "/net-worth.csv",
    "/query.csv", "/portfolio/holdings.csv", "/portfolio/lots.csv", "/portfolio/prices.csv",
  ]);
  return [...new Set(
    [...app.matchAll(/router\.get\(\s*"([^"]+)"/g)].map((m) => m[1]!),
  )].filter((p) => !p.includes(":") && !skip.has(p)).sort();
}

describe("15 · nobody sees anybody else's anything, on any screen", () => {
  test("the sweep covers most of the app", () => {
    assert.ok(paths.length > 25, `only ${paths.length} screens swept`);
  });

  for (const [what, secret] of Object.entries(SECRETS)) {
    test(`no screen shows Priya Ravi's private ${what}`, async () => {
      const leaked: string[] = [];
      for (const path of paths) {
        const res = await app.get(path);
        if (res.status !== 200) continue;
        if ((await res.text()).includes(secret)) leaked.push(path);
      }
      assert.deepEqual(
        leaked, [],
        `"${secret}" is in Ravi's own budget and these screens showed it to Priya: ` +
        leaked.join(", "),
      );
    });
  }

  test("and the exports do not either", async () => {
    // Deliberately separate: an export is a file somebody carries off, so it is
    // the worst place for this and the easiest one to forget.
    for (const path of ["/query.csv", "/net-worth.csv"]) {
      const body = await (await app.get(path)).text();
      for (const secret of Object.values(SECRETS)) {
        assert.ok(!body.includes(secret), `${path} carries "${secret}" off the machine`);
      }
    }
  });
});

describe("15 · the places a sweep of plain paths cannot reach", () => {
  test("a visible account's register leaves out rows filed to a private envelope", async () => {
    const res = await app.get(`/accounts/${visibleOfHisId}`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.ok(!body.includes(SECRETS.envelope), "the register names Ravi's private envelope");
    // Every row it does list opens: nothing links to a transaction page that 404s.
    for (const [, id] of body.matchAll(/href="\/transaction\/([^"]+)"/g)) {
      assert.equal((await app.get(`/transaction/${id}`)).status, 200, `row ${id} links to a 404`);
    }
    // Ravi still sees his own row, envelope and all.
    const his = await startTestApp(app.db, { memberId: RAVI });
    try {
      const own = await (await his.get(`/accounts/${visibleOfHisId}`)).text();
      assert.ok(own.includes(SECRETS.envelope), "the register hides Ravi's own envelope from Ravi");
      assert.deepEqual(his.failures, []);
    } finally {
      await his.close();
    }
  });

  test("another member's statement line cannot be approved, dismissed or merged", async () => {
    for (const verb of ["approve", "reject", "merge"]) {
      const res = await app.post(`/review/${verb}`, { staged_id: "staged-secret" });
      assert.equal(res.status, 404, `/review/${verb} acted on Ravi's private statement line`);
    }
    const row = app.db.prepare(`SELECT status FROM staged_transactions WHERE id = 'staged-secret'`)
      .get() as { status: string };
    assert.equal(row.status, "pending");
  });

  test("the badge counts what the review page shows the same reader", async () => {
    const mine = reviewCount(app.db, RAVI);
    const hers = reviewCount(app.db, PRIYA);
    // Ravi's pending statement line, unfiled expense and broken checkpoint.
    assert.ok(mine - hers >= 3, `Priya's badge ${hers} counts Ravi's queue (his: ${mine})`);
  });
});

describe("15 · and the holder still sees their own", () => {
  test("every private thing is visible to Ravi somewhere", async () => {
    const db = freshDb();
    seedMember(db, RAVI, "Ravi");
    const his = ensurePersonalBudget(db, RAVI, "Ravi");
    const account = createAccount(db, ravi, {
      name: SECRETS.account, kind: "budget", subtype: "savings",
      openingDate: "2026-01-01", openingBalance: rupees(3_00_000),
      holderMemberId: RAVI, visibility: "private", budgetId: his.id,
    });
    createLoan(db, ravi, {
      lender: SECRETS.loan, loanType: "personal", sanctioned: rupees(1_00_000),
      sanctionDate: "2026-01-01", interestModel: "reducing", annualRatePct: 13,
      tenureMonths: 24, currentOutstanding: rupees(1_00_000),
      repaymentAccountId: account.id, holderMemberId: RAVI, visibility: "private",
    });
    createFamilyLoan(db, ravi, {
      counterparty: SECRETS.arrangement, holderMemberId: RAVI, visibility: "private",
    });

    const mine = await startTestApp(db, { memberId: RAVI });
    try {
      const seen = [
        [SECRETS.account, `/accounts?budget=${encodeURIComponent(his.id)}`],
        [SECRETS.loan, "/loans"],
        [SECRETS.arrangement, "/family"],
      ] as const;
      for (const [secret, path] of seen) {
        const body = await (await mine.get(path)).text();
        assert.ok(body.includes(secret), `${path} hides Ravi's own ${secret} from Ravi`);
      }
      assert.deepEqual(mine.failures, []);
    } finally {
      await mine.close();
    }
  });
});
