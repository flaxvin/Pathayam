/**
 * IMPORT-1 · A budgeting app's export, into the ordinary pipeline.
 *
 * `budget-apps.ts` reads the file; this decides, for each row, which Pathayam
 * account it goes to (the person's choice, per source account — none is ever
 * created here), which envelope its category names, and whether it is a
 * transfer between two of the chosen accounts. Then every account's rows go
 * through `ingest()` like a bank statement's, so the duplicate check, the
 * rules and the review queue all apply, and nothing reaches the ledger
 * without being approved.
 *
 * Only transactions come across. What the other app had assigned to each
 * category is never read: those figures were decided against that app's own
 * balances and months, and written into Pathayam's envelopes they would count
 * the same money twice and overwrite the plan made here.
 */

import type { DB } from "../db/db.ts";
import { queryAll } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import type { Paise } from "../core/money.ts";
import { listCategories } from "../domain/budget.ts";
import { ingest, type IngestResult } from "./pipeline.ts";
import type { ParseError, RawRecord } from "./csv.ts";
import type { BudgetAppParse, SourceCategory } from "./budget-apps.ts";

/** An envelope a source category can be matched to. */
export interface Envelope {
  id: string;
  name: string;
  groupName: string;
}

const fold = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * The envelope a source category names, or null.
 *
 * "Group: Category" first — an envelope of that name in a group of that name —
 * then the category's name alone, but only when exactly one envelope has it:
 * YNAB's "Bills: Insurance" and "Car: Insurance" are two categories, and
 * filing both into whichever "Insurance" came first would be a guess. An
 * unmatched row is left with no envelope, so it waits in Review.
 */
export function matchEnvelope(category: SourceCategory | null, envelopes: Envelope[]): string | null {
  if (!category) return null;
  const name = fold(category.name);
  if (category.group) {
    const group = fold(category.group);
    const both = envelopes.filter((e) => fold(e.name) === name && fold(e.groupName) === group);
    if (both.length === 1) return both[0]!.id;
    // An envelope literally named "Group: Category" counts as the full path too.
    const literal = envelopes.filter((e) => fold(e.name) === `${group}: ${name}`);
    if (literal.length === 1) return literal[0]!.id;
  }
  const byName = envelopes.filter((e) => fold(e.name) === name);
  return byName.length === 1 ? byName[0]!.id : null;
}

/**
 * The envelopes the importing member may file into: the household's and their
 * own, and not a card's payment envelope or a commitment to another budget,
 * which no imported row may name (the same list Review offers).
 */
export function envelopesFor(db: DB, viewerMemberId: string | null): Envelope[] {
  const groups = new Map(
    queryAll<{ id: string; name: string }>(db, `SELECT id, name FROM category_groups WHERE kind = 'normal'`)
      .map((g) => [g.id, g.name]),
  );
  return listCategories(db, { viewerMemberId })
    .filter((c) => !c.payment_account_id && !c.commits_to_budget_id && groups.has(c.group_id))
    .map((c) => ({ id: c.id, name: c.name, groupName: groups.get(c.group_id)! }));
}

export interface BudgetAppPlan {
  /** Pathayam account id → its rows and the errors on them. */
  byAccount: Map<string, { records: RawRecord[]; errors: ParseError[] }>;
  /** Rows matched to an envelope, rows left for Review to file, transfers, splits. */
  matched: number;
  unmatched: number;
  transfers: number;
  splits: number;
  /** Rows of source accounts the person chose not to import. */
  leftOut: number;
}

/**
 * Pure: the parsed file and the person's account choices, as records per
 * Pathayam account. `accounts` maps a source account's name to a Pathayam
 * account id; a source account missing from it is not imported.
 */
export function planBudgetAppImport(
  parse: BudgetAppParse, accounts: Map<string, string>, envelopes: Envelope[],
): BudgetAppPlan {
  const plan: BudgetAppPlan = {
    byAccount: new Map(), matched: 0, unmatched: 0, transfers: 0, splits: 0, leftOut: 0,
  };
  const slot = (accountId: string) => {
    let entry = plan.byAccount.get(accountId);
    if (!entry) plan.byAccount.set(accountId, entry = { records: [], errors: [] });
    return entry;
  };
  for (const accountId of new Set(accounts.values())) slot(accountId);

  for (const t of parse.transactions) {
    const accountId = accounts.get(t.account);
    if (!accountId) {
      plan.leftOut++;
      continue;
    }
    // A transfer only between two accounts that are both coming across, and
    // not two source accounts folded into one Pathayam account.
    const otherId = t.transferTo ? accounts.get(t.transferTo) ?? null : null;
    const transferAccountId = otherId && otherId !== accountId ? otherId : null;

    const splits = t.splits?.map((line) => ({
      categoryId: matchEnvelope(line.category, envelopes),
      amount: line.amount as Paise,
      memo: line.memo,
    })) ?? null;
    const categoryId = transferAccountId || splits ? null : matchEnvelope(t.category, envelopes);

    if (transferAccountId) plan.transfers++;
    else if (splits) {
      plan.splits++;
      if (splits.every((l) => l.categoryId || l.amount >= 0)) plan.matched++;
      else plan.unmatched++;
    } else if (categoryId) plan.matched++;
    else if (t.amount < 0) plan.unmatched++;

    slot(accountId).records.push({
      rowNumber: t.rowNumber,
      date: t.date,
      amount: t.amount,
      narration: t.payee ?? t.memo ?? "",
      reference: null,
      raw: t.raw,
      proposed: { payee: t.payee, memo: t.memo, categoryId, transferAccountId, splits },
    });
  }

  for (const error of parse.errors) {
    const accountId = error.account ? accounts.get(error.account) : undefined;
    // A row of an account left behind is left behind with it. One that names
    // no account at all is reported with the first account imported.
    const target = accountId ?? (error.account ? null : [...plan.byAccount.keys()][0] ?? null);
    if (!target) continue;
    slot(target).errors.push({ rowNumber: error.rowNumber, cells: error.cells, reason: error.reason });
  }

  return plan;
}

export interface BudgetAppImportResult {
  plan: BudgetAppPlan;
  outcomes: IngestResult[];
}

/** Import a parsed export: one batch per chosen Pathayam account. */
export function importBudgetApp(
  db: DB, actor: Actor,
  input: {
    parse: BudgetAppParse;
    accounts: Map<string, string>;
    viewerMemberId: string | null;
    fileName: string;
  },
): BudgetAppImportResult {
  const plan = planBudgetAppImport(input.parse, input.accounts, envelopesFor(db, input.viewerMemberId));
  const outcomes: IngestResult[] = [];
  for (const [accountId, { records, errors }] of plan.byAccount) {
    outcomes.push(ingest(db, actor, {
      accountId, source: "csv", adapter: input.parse.app, fileName: input.fileName,
      records, errors, rowsRead: records.length + errors.length,
    }));
  }
  return { plan, outcomes };
}
