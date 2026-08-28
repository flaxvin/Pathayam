/**
 * F2 · Accounts, and R6's payment categories.
 *
 * Every mutation here appends an event (N20) and is wrapped in a transaction,
 * so a half-created Credit account without its payment category is not a state
 * the database can reach.
 */

import type { DB } from "../db/db.ts";
import { newId, transact, queryAll, queryOne, execute } from "../db/db.ts";
import { appendEvent, registerUndoHandler, type Actor } from "../core/events.ts";
import { nowIST, todayIST, type IsoDate } from "../core/dates.ts";
import { formatPaise, type Paise } from "../core/money.ts";

export type AccountKind = "budget" | "credit" | "tracking";

/** F2.2–F2.4. The subtype is what the UI shows; the kind is what the engine uses. */
export const ACCOUNT_SUBTYPES: Record<AccountKind, string[]> = {
  budget: ["savings", "current", "cash", "wallet"],
  credit: ["credit-card", "charge-card"],
  // `10` §3.5 · F2.10 adds family-loan: money lent to or borrowed from a
  // person. Tracking, so FW1 keeps it out of the budget, but distinct from
  // "asset"/"liability" because its balance is derived rather than typed.
  tracking: [
    "loan", "emi", "fixed-deposit", "recurring-deposit", "asset", "liability",
    "family-loan",
  ],
};

/**
 * B56 · Subtypes that carry a companion record and so must be created through
 * their own screen, never the generic "Add an account" form.
 *
 * A family-loan needs a `family_loans` row (created by `/family/new`) and a loan
 * needs a `loans` row with its amortisation (created by `/loans/new`). Making a
 * bare account of either subtype through the accounts form produced an orphan —
 * a tracking balance that never appeared on the Lending or Loans page, because
 * those pages read the companion table, not the account subtype.
 */
export const MANAGED_SUBTYPES: Record<string, { where: string; label: string }> = {
  "family-loan": { where: "/family", label: "the Lending page" },
  loan: { where: "/loans", label: "the Loans page" },
  emi: { where: "/loans", label: "the Loans page" },
};

export const SUBTYPE_LABELS: Record<string, string> = {
  savings: "Savings account",
  current: "Current account",
  cash: "Cash in hand",
  wallet: "Prepaid / UPI wallet",
  "credit-card": "Credit card",
  "charge-card": "Charge card",
  loan: "Loan",
  emi: "EMI",
  "fixed-deposit": "Fixed deposit",
  "recurring-deposit": "Recurring deposit",
  "family-loan": "Lent to or borrowed from family",
  asset: "Other asset",
  liability: "Other liability",
};

export interface Account {
  id: string;
  name: string;
  nickname: string | null;
  kind: AccountKind;
  subtype: string;
  institution: string | null;
  last4: string | null;
  currency: string;
  opening_balance: Paise;
  opening_date: IsoDate;
  statement_day: number | null;
  due_day: number | null;
  credit_limit: Paise | null;
  sort: number;
  closed_at: string | null;
}

export interface CreateAccountInput {
  name: string;
  kind: AccountKind;
  subtype: string;
  nickname?: string | null;
  institution?: string | null;
  last4?: string | null;
  /**
   * F2.5: for a Budget account this arrives in RTA as income. F2.6: for a
   * Credit account, pass the current outstanding as a negative figure.
   */
  openingBalance?: Paise;
  openingDate?: IsoDate;
  statementDay?: number | null;
  dueDay?: number | null;
  creditLimit?: Paise | null;
}

export function createAccount(db: DB, actor: Actor, input: CreateAccountInput): Account {
  if (!ACCOUNT_SUBTYPES[input.kind]?.includes(input.subtype)) {
    throw new Error(`"${input.subtype}" is not a valid subtype for a ${input.kind} account.`);
  }
  if (input.kind === "credit" && (input.openingBalance ?? 0) > 0) {
    throw new Error(
      "A credit account's opening balance is what you owe, so it must be zero or negative.",
    );
  }

  return transact(db, () => {
    const id = newId();
    const openingDate = input.openingDate ?? todayIST();
    const sort =
      (queryOne<{ n: number }>(db, `SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM accounts`)?.n) ?? 1;

    execute(
      db,
      `INSERT INTO accounts
         (id,name,nickname,kind,subtype,institution,last4,currency,opening_balance,
          opening_date,statement_day,due_day,credit_limit,sort,created_at,created_by)
       VALUES (?,?,?,?,?,?,?,'INR',?,?,?,?,?,?,?,?)`,
      id,
      input.name,
      input.nickname ?? null,
      input.kind,
      input.subtype,
      input.institution ?? null,
      input.last4 ?? null,
      input.openingBalance ?? 0,
      openingDate,
      input.statementDay ?? null,
      input.dueDay ?? null,
      input.creditLimit ?? null,
      sort,
      nowIST(),
      actor.memberId,
    );

    if (input.kind === "credit") {
      // R6: the payment category is created with the account and cannot be
      // deleted while it exists. It starts at ₹0 even when there is opening
      // debt — the gap is a debt figure, never a budgeting error.
      createPaymentCategory(db, actor, id, input.name);
      // R6.c: every card transaction records which card. A Credit account
      // always has at least its primary card so that is never null.
      createCard(db, actor, {
        accountId: id,
        label: input.name,
        last4: input.last4 ?? null,
        isPrimary: true,
        holderMemberId: actor.memberId,
      });
    }

    const account = getAccount(db, id)!;
    appendEvent(db, actor, {
      entity: "account",
      entityId: id,
      action: "create",
      after: account,
      summary: `Added ${input.name} with an opening balance of ${formatPaise(input.openingBalance ?? 0)}`,
    });
    return account;
  });
}

export function getAccount(db: DB, id: string): Account | null {
  return queryOne<Account>(db, `SELECT * FROM accounts WHERE id = ?`, id);
}

export function listAccounts(db: DB, opts: { includeClosed?: boolean } = {}): Account[] {
  return queryAll<Account>(
    db,
    `SELECT * FROM accounts ${opts.includeClosed ? "" : "WHERE closed_at IS NULL"}
      ORDER BY CASE kind WHEN 'budget' THEN 0 WHEN 'credit' THEN 1 ELSE 2 END, sort, name`,
  );
}

export function updateAccount(
  db: DB,
  actor: Actor,
  id: string,
  patch: Partial<Pick<Account, "name" | "nickname" | "institution" | "last4" | "statement_day" | "due_day" | "credit_limit" | "sort">>,
): Account {
  return transact(db, () => {
    const before = getAccount(db, id);
    if (!before) throw new Error("That account does not exist.");

    const fields = Object.keys(patch) as (keyof typeof patch)[];
    if (fields.length > 0) {
      execute(
        db,
        `UPDATE accounts SET ${fields.map((f) => `${f} = ?`).join(", ")} WHERE id = ?`,
        ...fields.map((f) => (patch[f] ?? null) as never),
        id,
      );
    }

    const after = getAccount(db, id)!;
    appendEvent(db, actor, {
      entity: "account",
      entityId: id,
      action: "update",
      before,
      after,
      summary: `Edited ${after.name}`,
    });
    return after;
  });
}

/** F2.7: closeable without deletion. History and balances are retained. */
export function closeAccount(db: DB, actor: Actor, id: string): void {
  transact(db, () => {
    const before = getAccount(db, id);
    if (!before) throw new Error("That account does not exist.");
    execute(db, `UPDATE accounts SET closed_at = ? WHERE id = ?`, nowIST(), id);
    appendEvent(db, actor, {
      entity: "account",
      entityId: id,
      action: "close",
      before,
      after: getAccount(db, id),
      summary: `Closed ${before.name}`,
    });
  });
}

export function reopenAccount(db: DB, actor: Actor, id: string): void {
  transact(db, () => {
    const before = getAccount(db, id);
    if (!before) throw new Error("That account does not exist.");
    execute(db, `UPDATE accounts SET closed_at = NULL WHERE id = ?`, id);
    appendEvent(db, actor, {
      entity: "account",
      entityId: id,
      action: "reopen",
      before,
      after: getAccount(db, id),
      summary: `Reopened ${before.name}`,
    });
  });
}

// ---------------------------------------------------------------------------
// Cards — R6.a to R6.g
// ---------------------------------------------------------------------------

export interface Card {
  id: string;
  account_id: string;
  label: string;
  last4: string | null;
  is_primary: number;
  holder_member_id: string | null;
  spend_cap_note: string | null;
  closed_at: string | null;
}

export interface CreateCardInput {
  accountId: string;
  label: string;
  last4?: string | null;
  isPrimary?: boolean;
  holderMemberId?: string | null;
  spendCapNote?: string | null;
}

/**
 * Add a card to a Credit account. An **add-on** is just a non-primary card
 * here: R6.a says an add-on is a sub-card, never a Credit account of its own,
 * so it shares the limit, the statement, the due date and the one payment
 * category (R6.b) without any of that needing special handling.
 */
export function createCard(db: DB, actor: Actor, input: CreateCardInput): Card {
  return transact(db, () => {
    const account = getAccount(db, input.accountId);
    if (!account) throw new Error("That account does not exist.");
    if (account.kind !== "credit") {
      throw new Error("Cards belong to credit accounts only.");
    }

    const id = newId();
    execute(
      db,
      `INSERT INTO cards (id,account_id,label,last4,is_primary,holder_member_id,spend_cap_note,created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      id,
      input.accountId,
      input.label,
      input.last4 ?? null,
      input.isPrimary ? 1 : 0,
      input.holderMemberId ?? null,
      input.spendCapNote ?? null,
      nowIST(),
    );

    const card = queryOne<Card>(db, `SELECT * FROM cards WHERE id = ?`, id)!;
    appendEvent(db, actor, {
      entity: "card",
      entityId: id,
      action: "create",
      after: card,
      summary: input.isPrimary
        ? `Added the primary card on ${account.name}`
        : `Added an add-on card "${input.label}" on ${account.name}`,
    });
    return card;
  });
}

export function listCards(db: DB, accountId: string, opts: { includeClosed?: boolean } = {}): Card[] {
  return queryAll<Card>(
    db,
    `SELECT * FROM cards WHERE account_id = ? ${opts.includeClosed ? "" : "AND closed_at IS NULL"}
      ORDER BY is_primary DESC, label`,
    accountId,
  );
}

/** R6.e: an alert naming an add-on's last four resolves to that card. */
/** F2.9 · Resolve an account by the last-four an alert or statement names. */
export function findAccountByLast4(db: DB, last4: string): Account | null {
  return queryOne<Account>(
    db,
    `SELECT * FROM accounts WHERE last4 = ? AND closed_at IS NULL ORDER BY created_at LIMIT 1`,
    last4,
  );
}

export function findCardByLast4(db: DB, last4: string): Card | null {
  return queryOne<Card>(
    db,
    `SELECT * FROM cards WHERE last4 = ? AND closed_at IS NULL LIMIT 1`,
    last4,
  );
}

/** R6.f: closing an add-on leaves the account and its payment category alone. */
export function closeCard(db: DB, actor: Actor, id: string): void {
  transact(db, () => {
    const before = queryOne<Card>(db, `SELECT * FROM cards WHERE id = ?`, id);
    if (!before) throw new Error("That card does not exist.");
    if (before.is_primary) {
      throw new Error("Close the account rather than its primary card.");
    }
    execute(db, `UPDATE cards SET closed_at = ? WHERE id = ?`, nowIST(), id);
    appendEvent(db, actor, {
      entity: "card",
      entityId: id,
      action: "close",
      before,
      after: queryOne<Card>(db, `SELECT * FROM cards WHERE id = ?`, id),
      summary: `Closed the add-on card "${before.label}"`,
    });
  });
}

// ---------------------------------------------------------------------------
// Payment categories (R6)
// ---------------------------------------------------------------------------

export const CREDIT_PAYMENTS_GROUP = "Credit Card Payments";

function createPaymentCategory(db: DB, actor: Actor, accountId: string, accountName: string): string {
  let group = queryOne<{ id: string }>(
    db,
    `SELECT id FROM category_groups WHERE kind = 'credit-payments' LIMIT 1`,
  );
  if (!group) {
    const groupId = newId();
    execute(
      db,
      `INSERT INTO category_groups (id,name,kind,sort,created_at) VALUES (?,?,'credit-payments',?,?)`,
      groupId,
      CREDIT_PAYMENTS_GROUP,
      -1, // Sits above ordinary groups on the budget screen.
      nowIST(),
    );
    group = { id: groupId };
  }

  const id = newId();
  execute(
    db,
    `INSERT INTO categories (id,group_id,name,sort,payment_account_id,created_at) VALUES (?,?,?,?,?,?)`,
    id,
    group.id,
    accountName,
    0,
    accountId,
    nowIST(),
  );

  appendEvent(db, actor, {
    entity: "category",
    entityId: id,
    action: "create",
    summary: `Created the payment category for ${accountName}`,
  });
  return id;
}

export function paymentCategoryFor(db: DB, accountId: string): { id: string; name: string } | null {
  return queryOne<{ id: string; name: string }>(
    db,
    `SELECT id, name FROM categories WHERE payment_account_id = ?`,
    accountId,
  );
}

registerUndoHandler("account", (db, event) => {
  const before = event.before as Account | undefined;
  if (!before) {
    execute(db, `DELETE FROM cards WHERE account_id = ?`, event.entityId!);
    execute(db, `DELETE FROM categories WHERE payment_account_id = ?`, event.entityId!);
    execute(db, `DELETE FROM accounts WHERE id = ?`, event.entityId!);
    return `Removed the account that was added`;
  }
  execute(
    db,
    `UPDATE accounts SET name=?, nickname=?, institution=?, last4=?, statement_day=?,
            due_day=?, credit_limit=?, closed_at=? WHERE id = ?`,
    before.name,
    before.nickname,
    before.institution,
    before.last4,
    before.statement_day,
    before.due_day,
    before.credit_limit,
    before.closed_at,
    event.entityId!,
  );
  return `Restored ${before.name}`;
});

// ---------------------------------------------------------------------------
// F2.3 · Credit-card statements. A card's cycle is not the calendar month, so
// the statement is entered rather than inferred; funding advice keys off it.
// ---------------------------------------------------------------------------

export interface CardStatement {
  id: string;
  account_id: string;
  statement_date: IsoDate;
  due_date: IsoDate;
  amount: Paise;
  minimum_due: Paise | null;
  created_at: string;
  created_by: string | null;
}

export function recordCardStatement(
  db: DB, actor: Actor,
  input: {
    accountId: string;
    statementDate: IsoDate;
    dueDate: IsoDate;
    amount: Paise;
    minimumDue?: Paise | null;
  },
): CardStatement {
  return transact(db, () => {
    const account = getAccount(db, input.accountId);
    if (!account) throw new Error("That account does not exist.");
    if (account.kind !== "credit") {
      throw new Error("Only a credit card has a statement.");
    }
    if (input.amount < 0) throw new Error("A statement balance is what is owed — zero or more.");

    const id = newId();
    execute(
      db,
      `INSERT INTO card_statements
         (id,account_id,statement_date,due_date,amount,minimum_due,created_at,created_by)
       VALUES (?,?,?,?,?,?,?,?)`,
      id, input.accountId, input.statementDate, input.dueDate, input.amount,
      input.minimumDue ?? null, nowIST(), actor.memberId,
    );
    const statement = queryOne<CardStatement>(db, `SELECT * FROM card_statements WHERE id = ?`, id)!;
    appendEvent(db, actor, {
      entity: "card-statement", entityId: id, action: "record", after: statement,
      summary:
        `Recorded a ${account.name} statement of ${formatPaise(input.amount)}` +
        `, due ${input.dueDate}`,
    });
    return statement;
  });
}

/** The most recent statement for a card, or null. */
export function lastCardStatement(db: DB, accountId: string): CardStatement | null {
  return queryOne<CardStatement>(
    db,
    `SELECT * FROM card_statements WHERE account_id = ?
      ORDER BY statement_date DESC, created_at DESC LIMIT 1`,
    accountId,
  );
}
