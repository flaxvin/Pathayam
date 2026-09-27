/**
 * `04` §6.4 · Rule learning, and F6.6 · retroactive apply.
 *
 * The rule that shapes all of it is L3: **proposals appear in the Review
 * queue, never auto-applied** (P3, N2). The app may notice a pattern; it may
 * not act on one.
 *
 * L2's threshold is deliberate and worth keeping: a rule is proposed on the
 * *second* categorisation, not the first. "Once is coincidence; twice is a
 * pattern." Proposing after one would train the household to dismiss.
 */

import type { DB } from "../db/db.ts";
import { newId, transact, queryAll, queryOne, execute } from "../db/db.ts";
import { appendEvent, registerUndoHandler, undoEvent, type Actor } from "../core/events.ts";
import { Refusal } from "../core/refusal.ts";
import { refusePaymentCategories, UndoRefused } from "../domain/transactions.ts";
import { prepareClaim, sharedInstrumentBetween } from "../domain/commitments.ts";
import { hiddenTransactionSql } from "../domain/member-scope.ts";
import { nowIST } from "../core/dates.ts";
import { Missing } from "../core/refusal.ts";
import type { Rule, RuleStage } from "./rules.ts";
import { extractNarrationFields, applyRules, type RuleSubject } from "./rules.ts";

export interface Proposal {
  id: string;
  name: string;
  stage: RuleStage;
  conditions: Rule["conditions"];
  actions: Rule["actions"];
  /** Stated to the user, so a proposal is never an unexplained suggestion. */
  because: string;
  /** N9 · How many times the app saw this, for ordering the list it lands in. */
  strength?: number;
}

/**
 * L2 · Categorising a transaction from a payee for the second time proposes a
 * `default`-stage rule for that payee.
 */
export function proposeCategoryRules(db: DB, actor: Actor): Proposal[] {
  const candidates = queryAll<{
    payee_id: string; payee: string; category_id: string; category: string; n: number;
  }>(
    db,
    `SELECT t.payee_id, p.name AS payee, t.category_id, c.name AS category, COUNT(*) AS n
       FROM transactions t
       JOIN payees p ON p.id = t.payee_id
       JOIN categories c ON c.id = t.category_id
      WHERE t.deleted_at IS NULL AND t.payee_id IS NOT NULL AND t.category_id IS NOT NULL
        AND c.payment_account_id IS NULL
      GROUP BY t.payee_id, t.category_id
     HAVING n >= 2
      ORDER BY n DESC`,
  );

  const created: Proposal[] = [];

  for (const candidate of candidates) {
    // L4/L5: never propose something already covered, already refused, or
    // already proposed and waiting.
    const already = queryOne<{ id: string }>(
      db,
      `SELECT id FROM rules WHERE conditions_json LIKE ? AND actions_json LIKE ?`,
      `%"${candidate.payee}"%`, `%"${candidate.category_id}"%`,
    );
    if (already) continue;
    if (isSuppressed(db, "learned-rule", `${candidate.payee_id}:${candidate.category_id}`)) continue;

    const proposal: Proposal = {
      id: newId(),
      name: `${candidate.payee} → ${candidate.category}`,
      stage: "default",
      conditions: [{ field: "payee", op: "is", value: candidate.payee }],
      actions: [{ type: "setCategory", categoryId: candidate.category_id }],
      because: `You've put ${candidate.payee} in ${candidate.category} ${candidate.n} times.`,
      // N9 · The evidence as a number as well as a sentence, so the list can be
      // ordered by it rather than by when it happened to be written.
      strength: candidate.n,
    };

    persist(db, actor, proposal);
    created.push(proposal);
  }

  return created;
}

/**
 * L1 · Renaming an imported payee proposes a `pre`-stage rule mapping that raw
 * string to the clean name — so next month's identical narration arrives
 * already named.
 */
export function proposePayeeRule(
  db: DB, actor: Actor, input: { rawNarration: string; cleanName: string },
): Proposal | null {
  const extracted = extractNarrationFields(input.rawNarration);
  // Matching the merchant rather than the whole string is what keeps the rule
  // working when the order id changes — which it does every time (F6.9).
  const field = extracted.merchant ? "merchant" : "narration";
  const value = extracted.merchant ?? input.rawNarration;

  if (isSuppressed(db, "learned-payee", `${value}:${input.cleanName}`)) return null;

  const already = queryOne<{ id: string }>(
    db,
    `SELECT id FROM rules WHERE stage = 'pre' AND conditions_json LIKE ? AND dismissed_at IS NULL`,
    `%"${value}"%`,
  );
  if (already) return null;

  const proposal: Proposal = {
    id: newId(),
    name: `${value} → ${input.cleanName}`,
    stage: "pre",
    conditions: [{ field: field as "merchant", op: "is", value }],
    actions: [{ type: "setPayee", payee: input.cleanName }],
    because: `You renamed "${value}" to "${input.cleanName}".`,
    // One deliberate rename is weaker evidence than a habit, and reads as such.
    strength: 1,
  };

  persist(db, actor, proposal);
  return proposal;
}

function persist(db: DB, actor: Actor, proposal: Proposal): void {
  transact(db, () => {
    // N9: `because` is stored, not just logged, so Review can show the
    // inference next to the button that acts on it.
    execute(
      db,
      `INSERT INTO rules
         (id,name,stage,conditions_json,actions_json,enabled,proposed,because,strength,
          created_at,created_by)
       VALUES (?,?,?,?,?,1,1,?,?,?,?)`,
      proposal.id, proposal.name, proposal.stage,
      JSON.stringify(proposal.conditions), JSON.stringify(proposal.actions),
      proposal.because, proposal.strength ?? null, nowIST(), actor.memberId,
    );
    appendEvent(db, actor, {
      entity: "rule", entityId: proposal.id, action: "propose",
      after: { name: proposal.name, because: proposal.because },
      // L3: this is a proposal in Review, never an applied rule.
      summary: `Suggested a rule: ${proposal.name}. ${proposal.because}`,
    });
  });
}

/** L5 · Dismissing a proposal suppresses that specific proposal permanently. */
/**
 * L5 · Accepting a proposal, and refusing one for good.
 *
 * These two lived in the router, as a bare UPDATE and a paragraph of suppression
 * logic inside a route handler. That is why nothing could exercise them: the
 * step between "the app suggested a rule" and "the rule files things" was
 * reachable only by posting a form, so a three-year simulation could propose
 * forty-three rules and apply exactly none of them, and no test noticed that the
 * middle of the feature was never run.
 *
 * A proposal is a rule with `proposed = 1`. Confirming clears the flag, which is
 * the whole change — the rule already exists, enabled, with its conditions and
 * actions; it was simply waiting to be believed.
 */
export function confirmRule(db: DB, actor: Actor, ruleId: string): void {
  transact(db, () => {
    // No row, no event: a made-up id used to "succeed" and log a confirmation
    // of nothing (SECURITY-OPS-8).
    if (execute(db, `UPDATE rules SET proposed = 0 WHERE id = ?`, ruleId) === 0) {
      throw new Missing("That rule does not exist.");
    }
    appendEvent(db, actor, {
      entity: "rule", entityId: ruleId, action: "confirm",
      summary: `Confirmed a proposed rule`,
    });
  });
}

/**
 * Dismissing suppresses *that specific proposal* permanently, so the same
 * suggestion never comes back — L5's promise that saying no is heard once and
 * remembered, rather than re-asked every time the same pattern is seen again.
 */
export function dismissRule(
  db: DB, actor: Actor, ruleId: string, rule?: Pick<Rule, "conditions" | "actions">,
): void {
  transact(db, () => {
    if (execute(db, `UPDATE rules SET dismissed_at = ? WHERE id = ?`, nowIST(), ruleId) === 0) {
      throw new Missing("That rule does not exist.");
    }

    if (rule) {
      const condition = rule.conditions[0];
      const action = rule.actions[0] as { categoryId?: string; payee?: string } | undefined;
      suppress(
        db,
        action?.categoryId ? "learned-rule" : "learned-payee",
        `${String(condition?.value ?? "")}:${action?.categoryId ?? action?.payee ?? ""}`,
        actor.memberId,
      );
    }

    appendEvent(db, actor, {
      entity: "rule", entityId: ruleId, action: "dismiss",
      summary: `Dismissed a proposed rule; it won't be suggested again`,
    });
  });
}

export function suppress(db: DB, kind: string, ref: string, memberId: string | null): void {
  execute(
    db,
    `INSERT OR REPLACE INTO review_dismissals (kind, ref, at, member_id) VALUES (?,?,?,?)`,
    kind, ref, nowIST(), memberId,
  );
}

function isSuppressed(db: DB, kind: string, ref: string): boolean {
  return (
    queryOne(db, `SELECT ref FROM review_dismissals WHERE kind = ? AND ref = ?`, kind, ref) !== null
  );
}

/** L4 · Learning is disableable globally, and per payee. */
export function setLearningEnabled(db: DB, actor: Actor, enabled: boolean): void {
  transact(db, () => {
    execute(
      db,
      `INSERT INTO settings_kv (key, value, updated_at) VALUES ('rule-learning', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      enabled ? "on" : "off", nowIST(),
    );
    appendEvent(db, actor, {
      entity: "settings", entityId: "rule-learning", action: "set",
      after: { enabled },
      summary: enabled
        ? "Turned rule suggestions back on"
        : "Turned rule suggestions off — nothing will be proposed from your behaviour",
    });
  });
}

export function learningEnabled(db: DB): boolean {
  const row = queryOne<{ value: string }>(
    db, `SELECT value FROM settings_kv WHERE key = 'rule-learning'`,
  );
  return row?.value !== "off";
}

// ---------------------------------------------------------------------------
// F6.6 · Retroactive apply
// ---------------------------------------------------------------------------

export interface RetroactiveMatch {
  transactionId: string;
  date: string;
  payee: string | null;
  amount: number;
  currentCategory: string | null;
  proposedCategory: string | null;
}

export interface RetroactivePreview {
  matches: RetroactiveMatch[];
  /** F6.6 requires a count and a preview *before* commit. */
  count: number;
  /** How many would actually change — the rest already agree with the rule. */
  changing: number;
}

/**
 * The history a rule is tried against, as `viewerMemberId` may see it.
 *
 * MONEY-CORE-10 / 11 / 22 · This read every live transaction in the
 * household. Ravi's "Swiggy → Food" then listed, and re-filed, a ₹400 spend on
 * Priya's personal account (out of her own envelope, whose name the preview
 * showed) and an entry on her private tracking account — the same leak the
 * rules page itself is careful to avoid. Now: only rows the viewer can see
 * (account, envelope and every split line — member-scope's own test), only
 * budget accounts (a tracking account's rows carry no envelope), and no split
 * rows, whose envelopes are their lines — writing one `category_id` onto a
 * split changed nothing and was counted as a change.
 */
export function ruleSubjects(
  db: DB, viewerMemberId: string | null, limit = 2000,
): (RuleSubject & { id: string; payeeName: string | null; budgetId: string | null })[] {
  const hidden = hiddenTransactionSql("t", viewerMemberId);
  return queryAll<{
    id: string; narration: string | null; payee: string | null; account_id: string;
    amount: number; date: string; memo: string | null; category_id: string | null;
    cleared: number; source: string; card_last4: string | null; budget_id: string | null;
  }>(
    db,
    `SELECT t.id, t.raw_narration AS narration, p.name AS payee, t.account_id, t.amount,
            t.date, t.memo, t.category_id, t.cleared, t.source, c.last4 AS card_last4, a.budget_id
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       LEFT JOIN payees p ON p.id = t.payee_id
       LEFT JOIN cards c ON c.id = t.card_id
      WHERE t.deleted_at IS NULL AND t.transfer_pair_id IS NULL
        AND t.is_split = 0 AND a.kind <> 'tracking'
        AND NOT ${hidden.sql}
      ORDER BY t.date DESC LIMIT ?`,
    ...hidden.params, limit,
  ).map((r) => {
    const narration = r.narration ?? r.payee ?? "";
    return {
      id: r.id,
      payeeName: r.payee,
      budgetId: r.budget_id,
      narration,
      importedPayee: r.payee,
      payee: r.payee,
      accountId: r.account_id,
      amount: r.amount,
      date: r.date,
      memo: r.memo,
      tags: [],
      categoryId: r.category_id,
      cleared: r.cleared === 1,
      source: r.source,
      cardLast4: r.card_last4,
      ...extractNarrationFields(narration),
    };
  });
}

/**
 * MONEY-CORE-10 / 27 · Whether the rule may file this row to that envelope:
 * the refusals every other filing path meets. The raw UPDATE below skipped
 * them, so a rule could file Priya's personal-account spend to a household
 * envelope with nothing linking the two budgets, or file spending to a card's
 * payment envelope or a commitment envelope — each put a budget's identity out
 * by the amount in every month after. A refused row is left as it is.
 */
function refuseRuleFiling(
  db: DB, subject: { accountId: string; budgetId: string | null }, categoryId: string,
): void {
  refusePaymentCategories(db, [categoryId]);
  const categoryBudget = queryOne<{ budget_id: string | null }>(
    db, `SELECT budget_id FROM categories WHERE id = ?`, categoryId,
  )?.budget_id ?? null;
  if (
    subject.budgetId && categoryBudget && subject.budgetId !== categoryBudget &&
    !sharedInstrumentBetween(db, subject.accountId, subject.budgetId, categoryBudget)
  ) {
    throw new Refusal("Nothing links the account's budget to that envelope's.");
  }
}

function fileable(db: DB, subject: { accountId: string; budgetId: string | null }, categoryId: string): boolean {
  try {
    refuseRuleFiling(db, subject, categoryId);
    return true;
  } catch (err) {
    if (err instanceof Refusal) return false;
    throw err;
  }
}

/** F6.6 · What applying this rule to existing transactions would do, as `viewerMemberId` sees it. */
export function previewRetroactive(db: DB, rule: Rule, viewerMemberId: string | null): RetroactivePreview {
  const categoryNames = new Map(
    queryAll<{ id: string; name: string }>(db, `SELECT id, name FROM categories`)
      .map((c) => [c.id, c.name]),
  );

  const matches: RetroactiveMatch[] = [];
  let changing = 0;

  for (const subject of ruleSubjects(db, viewerMemberId)) {
    const outcome = applyRules(subject, [rule]);
    if (outcome.appliedRuleIds.length === 0) continue;

    const proposed = outcome.subject.categoryId;
    if (proposed && proposed !== subject.categoryId && !fileable(db, subject, proposed)) continue;
    if (proposed !== subject.categoryId) changing++;

    matches.push({
      transactionId: subject.id,
      date: subject.date,
      payee: subject.payeeName,
      amount: subject.amount,
      currentCategory: subject.categoryId ? categoryNames.get(subject.categoryId) ?? null : null,
      proposedCategory: proposed ? categoryNames.get(proposed) ?? null : null,
    });
  }

  return { matches: matches.slice(0, 50), count: matches.length, changing };
}

/**
 * F6.6 · Apply the rule to matching existing transactions.
 *
 * One idempotency key covers the batch (R36.8), so the whole retroactive
 * application undoes in a single action rather than transaction by transaction.
 */
export function applyRetroactive(db: DB, actor: Actor, rule: Rule): number {
  return transact(db, () => {
    let changed = 0;
    const eventIds: string[] = [];

    for (const subject of ruleSubjects(db, actor.memberId)) {
      const outcome = applyRules(subject, [rule]);
      if (outcome.appliedRuleIds.length === 0) continue;

      const proposed = outcome.subject.categoryId;
      if (!proposed || proposed === subject.categoryId) continue;
      /*
       * A rule naming an envelope that has since gone is refused outright, by
       * name, rather than skipped row by row: "Applied to 0 transactions" would
       * not say why (MONEY-CORE-26).
       */
      if (queryOne(db, `SELECT 1 FROM categories WHERE id = ? AND deleted_at IS NOT NULL`, proposed)) {
        refusePaymentCategories(db, [proposed]);
      }
      if (!fileable(db, subject, proposed)) continue;
      // Across two linked budgets the envelope between them carries the claim,
      // opened here if this is the first filing to need it — as updateTransaction does.
      const categoryBudget = queryOne<{ budget_id: string | null }>(
        db, `SELECT budget_id FROM categories WHERE id = ?`, proposed,
      )?.budget_id ?? null;
      prepareClaim(db, actor, subject.accountId, subject.budgetId, categoryBudget);

      const before = queryOne<Record<string, unknown>>(
        db, `SELECT * FROM transactions WHERE id = ?`, subject.id,
      );
      execute(
        db, `UPDATE transactions SET category_id = ?, updated_at = ? WHERE id = ?`,
        proposed, nowIST(), subject.id,
      );
      execute(
        db,
        `INSERT OR IGNORE INTO rule_applications (transaction_id, rule_id, at) VALUES (?,?,?)`,
        subject.id, rule.id, nowIST(),
      );

      eventIds.push(appendEvent(db, { ...actor, source: "rule", sourceDetail: rule.name }, {
        entity: "transaction", entityId: subject.id, action: "categorise",
        before, after: queryOne(db, `SELECT * FROM transactions WHERE id = ?`, subject.id),
        summary: `Categorised by the rule "${rule.name}"`,
      }).id);
      changed++;
    }

    execute(
      db, `UPDATE rules SET times_applied = times_applied + ? WHERE id = ?`, changed, rule.id,
    );

    appendEvent(db, actor, {
      entity: "rule", entityId: rule.id, action: "apply-retroactive",
      after: { changed, eventIds },
      summary:
        `Applied "${rule.name}" to ${changed} existing ` +
        `${changed === 1 ? "transaction" : "transactions"}`,
    });

    return changed;
  });
}

/*
 * MONEY-CORE-12 · The apply page promises "Undoable in one action for the next
 * 30 days", and nothing could undo it: "rule" had no undo handler, so Activity
 * answered "Changes to rule cannot be undone" and the only way back was each
 * "Categorised by the rule" entry, one by one. The apply now records the
 * events it wrote, and undoing it undoes each of them — except a transaction
 * changed again since, which is the household's later decision and stays (the
 * same rule a payee merge's undo keeps). Only this action of a rule undoes;
 * the rest stay "cannot be undone", so Activity offers no button for them.
 */
registerUndoHandler("rule", (db, event, actor) => {
  const recorded = (event.after as { eventIds?: string[] } | undefined)?.eventIds;
  if (!recorded) {
    throw new UndoRefused(
      "That was recorded before an apply kept a list of what it changed. Undo each " +
      "\"Categorised by the rule\" entry instead.",
    );
  }
  let back = 0;
  for (const id of recorded) {
    try {
      if (undoEvent(db, id, actor).ok) back++;
    } catch (err) {
      // Refused before writing (its old envelope merged away since, say): kept.
      if (!(err instanceof UndoRefused || err instanceof Refusal)) throw err;
    }
  }
  const kept = recorded.length - back;
  return `Put ${back} ${back === 1 ? "transaction" : "transactions"} back as they were` +
    (kept > 0 ? `; ${kept} changed since ${kept === 1 ? "was" : "were"} left as ${kept === 1 ? "it is" : "they are"}` : "");
}, ["apply-retroactive"]);
