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
import { appendEvent, type Actor } from "../core/events.ts";
import { nowIST } from "../core/dates.ts";
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

function subjectsFor(db: DB, limit = 2000): (RuleSubject & { id: string; payeeName: string | null })[] {
  return queryAll<{
    id: string; narration: string | null; payee: string | null; account_id: string;
    amount: number; date: string; memo: string | null; category_id: string | null;
    cleared: number; source: string;
  }>(
    db,
    `SELECT t.id, t.raw_narration AS narration, p.name AS payee, t.account_id, t.amount,
            t.date, t.memo, t.category_id, t.cleared, t.source
       FROM transactions t LEFT JOIN payees p ON p.id = t.payee_id
      WHERE t.deleted_at IS NULL AND t.transfer_pair_id IS NULL
      ORDER BY t.date DESC LIMIT ?`,
    limit,
  ).map((r) => {
    const narration = r.narration ?? r.payee ?? "";
    return {
      id: r.id,
      payeeName: r.payee,
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
      cardLast4: null,
      ...extractNarrationFields(narration),
    };
  });
}

/** F6.6 · What applying this rule to existing transactions would do. */
export function previewRetroactive(db: DB, rule: Rule): RetroactivePreview {
  const categoryNames = new Map(
    queryAll<{ id: string; name: string }>(db, `SELECT id, name FROM categories`)
      .map((c) => [c.id, c.name]),
  );

  const matches: RetroactiveMatch[] = [];
  let changing = 0;

  for (const subject of subjectsFor(db)) {
    const outcome = applyRules(subject, [rule]);
    if (outcome.appliedRuleIds.length === 0) continue;

    const proposed = outcome.subject.categoryId;
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

    for (const subject of subjectsFor(db)) {
      const outcome = applyRules(subject, [rule]);
      if (outcome.appliedRuleIds.length === 0) continue;

      const proposed = outcome.subject.categoryId;
      if (!proposed || proposed === subject.categoryId) continue;

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

      appendEvent(db, { ...actor, source: "rule", sourceDetail: rule.name }, {
        entity: "transaction", entityId: subject.id, action: "categorise",
        before, after: queryOne(db, `SELECT * FROM transactions WHERE id = ?`, subject.id),
        summary: `Categorised by the rule "${rule.name}"`,
      });
      changed++;
    }

    execute(
      db, `UPDATE rules SET times_applied = times_applied + ? WHERE id = ?`, changed, rule.id,
    );

    appendEvent(db, actor, {
      entity: "rule", entityId: rule.id, action: "apply-retroactive",
      after: { changed },
      summary:
        `Applied "${rule.name}" to ${changed} existing ` +
        `${changed === 1 ? "transaction" : "transactions"}`,
    });

    return changed;
  });
}
