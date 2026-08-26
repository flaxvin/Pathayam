/**
 * F6 · The rules engine, and `04` §3.6's UPI narration extraction.
 *
 * Three ordered stages, and within a stage rules are auto-ordered
 * least-specific to most-specific (R-E2) so a broad cleanup rule runs before a
 * narrow override. **Users never hand-order rules** — that is the whole point
 * of the auto-ordering, and it is why there is no `sort` column here.
 *
 * Everything a rule produces is a proposal until a human confirms it (N9, I2).
 */

import type { Paise } from "../core/money.ts";
import type { IsoDate } from "../core/dates.ts";

export type RuleStage = "pre" | "default" | "post";

export type ConditionField =
  | "narration" | "channel" | "vpa" | "merchant" | "reference"
  | "importedPayee" | "payee" | "account" | "amount" | "absoluteAmount"
  | "direction" | "date" | "dayOfMonth" | "memo" | "tags" | "category"
  | "cleared" | "source" | "cardLast4";

export type Operator =
  | "is" | "isNot" | "contains" | "doesNotContain" | "startsWith" | "endsWith"
  | "matches" | "oneOf" | "notOneOf" | "greaterThan" | "lessThan" | "between";

export interface Condition {
  field: ConditionField;
  op: Operator;
  value: string | number | string[] | [number, number];
}

export type Action =
  | { type: "setCategory"; categoryId: string }
  | { type: "setPayee"; payee: string }
  | { type: "setMemo"; memo: string; mode?: "set" | "prepend" | "append" }
  | { type: "addTag"; tag: string }
  | { type: "removeTag"; tag: string }
  | { type: "setOwner"; memberId: string }
  | { type: "setCleared"; cleared: boolean }
  | { type: "setAccount"; accountId: string }
  | { type: "setDate"; date: IsoDate }
  | { type: "splitFixed"; parts: { categoryId: string; amount: Paise }[] }
  | { type: "splitPercent"; parts: { categoryId: string; percent: number }[] }
  | { type: "markForReview" }
  | { type: "markAutoApprovable" }
  | { type: "ignore" };

export interface Rule {
  id: string;
  name: string;
  stage: RuleStage;
  /** All-of / any-of, with one level of nesting and no more (`04` §6.1). */
  match: "all" | "any";
  conditions: Condition[];
  actions: Action[];
  enabled: boolean;
}

/** What a rule sees. Fields absent from the source are simply undefined. */
export interface RuleSubject {
  narration: string;
  importedPayee: string | null;
  payee: string | null;
  accountId: string;
  amount: Paise;
  date: IsoDate;
  memo: string | null;
  tags: string[];
  categoryId: string | null;
  cleared: boolean;
  source: string;
  cardLast4: string | null;
  /** Populated by `extractNarrationFields` (F6.9). */
  channel: string | null;
  vpa: string | null;
  merchant: string | null;
  reference: string | null;
}

export interface RuleOutcome {
  subject: RuleSubject;
  /** R-E4 / F6.8: recorded on the transaction and shown in its details pane. */
  appliedRuleIds: string[];
  splits: { categoryId: string; amount: Paise }[] | null;
  markedForReview: boolean;
  autoApprovable: boolean;
  ignored: boolean;
}

// ---------------------------------------------------------------------------
// `04` §3.6 · UPI narration extraction
// ---------------------------------------------------------------------------

const CHANNELS = ["UPI", "IMPS", "NEFT", "RTGS", "POS", "ATM", "ECS", "NACH", "ACH", "EMI"];

/**
 * Pull named fields out of Indian narration so rules can match on structure
 * rather than regex over the whole string (F6.9).
 *
 * `UPI/P2M/431202847592/SWIGGY*ORDER` yields channel UPI, reference
 * 431202847592 and merchant SWIGGY — so a rule can say "merchant contains
 * SWIGGY" and keep working when the order id changes, which it does every time.
 */
export function extractNarrationFields(narration: string): {
  channel: string | null;
  vpa: string | null;
  merchant: string | null;
  reference: string | null;
} {
  const upper = narration.toUpperCase();

  const channel = CHANNELS.find((c) => new RegExp(`(^|[^A-Z])${c}([^A-Z]|$)`).test(upper)) ?? null;

  const vpaMatch = /([a-z0-9._-]+@[a-z][a-z0-9.-]*)/i.exec(narration);
  const vpa = vpaMatch ? vpaMatch[1]!.toLowerCase() : null;

  // The UPI RRN is 12 digits; bank references run longer. Take the longest
  // digit run of 6+, which is the reference in every shape seen so far.
  const numbers = narration.match(/\d{6,}/g) ?? [];
  const reference = numbers.length > 0 ? numbers.reduce((a, b) => (b.length >= a.length ? b : a)) : null;

  const merchant = extractMerchant(narration, vpa, reference);

  return { channel, vpa, merchant, reference };
}

function extractMerchant(narration: string, vpa: string | null, reference: string | null): string | null {
  // A VPA's local part is usually the merchant, and is the most reliable
  // signal when present.
  if (vpa) {
    const local = vpa.split("@")[0]!;
    // A VPA local part is lower case by convention, so it needs capitalising
    // outright rather than going through the ALL-CAPS guard in titleCase.
    if (!/^\d+$/.test(local)) return capitalise(local.replace(/[._-]+/g, " "));
  }

  const parts = narration
    .split(/[/|]/)
    .map((p) => p.trim())
    .filter(Boolean)
    .filter((p) => !CHANNELS.includes(p.toUpperCase()))
    .filter((p) => p !== reference)
    .filter((p) => !/^(P2M|P2A|DR|CR|PAYMENT|TXN|REF)$/i.test(p))
    .filter((p) => !/^\d+$/.test(p));

  if (parts.length === 0) return null;

  // `MERCHANT*SUBMERCHANT` collapses to MERCHANT (`04` §3.6).
  const candidate = parts.reduce((a, b) => (b.length > a.length ? b : a));
  const collapsed = candidate.split("*")[0]!.trim();
  const cleaned = collapsed.replace(/\s*\d{4,}\s*$/, "").trim();
  return cleaned ? titleCase(cleaned) : null;
}

function capitalise(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function titleCase(value: string): string {
  // ALL-CAPS merchant strings are the norm and read as shouting (`04` §3.6).
  if (value !== value.toUpperCase()) return value;
  return value
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

function fieldValue(subject: RuleSubject, field: ConditionField): string | number | string[] | null {
  switch (field) {
    case "narration": return subject.narration;
    case "channel": return subject.channel;
    case "vpa": return subject.vpa;
    case "merchant": return subject.merchant;
    case "reference": return subject.reference;
    case "importedPayee": return subject.importedPayee;
    case "payee": return subject.payee;
    case "account": return subject.accountId;
    case "amount": return subject.amount;
    case "absoluteAmount": return Math.abs(subject.amount);
    case "direction": return subject.amount < 0 ? "out" : "in";
    case "date": return subject.date;
    case "dayOfMonth": return Number(subject.date.slice(8, 10));
    case "memo": return subject.memo;
    case "tags": return subject.tags;
    case "category": return subject.categoryId;
    case "cleared": return subject.cleared ? "yes" : "no";
    case "source": return subject.source;
    case "cardLast4": return subject.cardLast4;
    default: return null;
  }
}

export function evaluateCondition(subject: RuleSubject, condition: Condition): boolean {
  const actual = fieldValue(subject, condition.field);
  const { op, value } = condition;

  if (Array.isArray(actual)) {
    // Only `tags` is list-valued.
    const list = actual.map((t) => t.toLowerCase());
    const needle = String(value).toLowerCase();
    switch (op) {
      case "contains": case "is": return list.includes(needle);
      case "doesNotContain": case "isNot": return !list.includes(needle);
      case "oneOf": return (value as string[]).some((v) => list.includes(v.toLowerCase()));
      case "notOneOf": return !(value as string[]).some((v) => list.includes(v.toLowerCase()));
      default: return false;
    }
  }

  if (op === "greaterThan" || op === "lessThan" || op === "between") {
    const n = typeof actual === "number" ? actual : Number(actual);
    if (!Number.isFinite(n)) return false;
    if (op === "greaterThan") return n > Number(value);
    if (op === "lessThan") return n < Number(value);
    const [low, high] = value as [number, number];
    return n >= low && n <= high;
  }

  const text = actual === null ? "" : String(actual).toLowerCase();
  const needle = Array.isArray(value) ? "" : String(value).toLowerCase();

  switch (op) {
    case "is": return text === needle;
    case "isNot": return text !== needle;
    case "contains": return text.includes(needle);
    case "doesNotContain": return !text.includes(needle);
    case "startsWith": return text.startsWith(needle);
    case "endsWith": return text.endsWith(needle);
    case "oneOf": return (value as string[]).some((v) => v.toLowerCase() === text);
    case "notOneOf": return !(value as string[]).some((v) => v.toLowerCase() === text);
    case "matches":
      try {
        // A rule is written by a household member, not an attacker, but a
        // malformed pattern must not take the whole import down.
        return new RegExp(String(value), "i").test(actual === null ? "" : String(actual));
      } catch {
        return false;
      }
    default: return false;
  }
}

export function ruleMatches(subject: RuleSubject, rule: Rule): boolean {
  if (!rule.enabled || rule.conditions.length === 0) return false;
  return rule.match === "all"
    ? rule.conditions.every((c) => evaluateCondition(subject, c))
    : rule.conditions.some((c) => evaluateCondition(subject, c));
}

/**
 * R-E2 · Specificity, used to order rules within a stage.
 *
 * More conditions is more specific; an exact match is more specific than a
 * substring; `all` is more specific than `any`. Users never see this — that is
 * the point.
 */
export function specificity(rule: Rule): number {
  let score = rule.conditions.length * 10;
  if (rule.match === "all") score += 5;
  for (const c of rule.conditions) {
    switch (c.op) {
      case "is": case "oneOf": score += 4; break;
      case "startsWith": case "endsWith": score += 3; break;
      case "matches": score += 2; break;
      case "contains": score += 1; break;
      default: break;
    }
    // A condition on an extracted field is narrower than one on raw narration.
    if (["vpa", "merchant", "reference", "cardLast4"].includes(c.field)) score += 2;
  }
  return score;
}

const STAGE_ORDER: RuleStage[] = ["pre", "default", "post"];

/** Order rules for execution: stage first, then least-specific to most (R-E2). */
export function orderRules(rules: Rule[]): Rule[] {
  return [...rules]
    .filter((r) => r.enabled)
    .sort(
      (a, b) =>
        STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage) ||
        specificity(a) - specificity(b) ||
        a.name.localeCompare(b.name),
    );
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export function applyRules(subject: RuleSubject, rules: Rule[]): RuleOutcome {
  const outcome: RuleOutcome = {
    subject: { ...subject, tags: [...subject.tags] },
    appliedRuleIds: [],
    splits: null,
    markedForReview: false,
    autoApprovable: false,
    ignored: false,
  };

  for (const rule of orderRules(rules)) {
    if (!ruleMatches(outcome.subject, rule)) continue;
    outcome.appliedRuleIds.push(rule.id);

    for (const action of rule.actions) {
      applyAction(outcome, action);
      if (outcome.ignored) return outcome; // Never import; nothing else matters.
    }
  }

  return outcome;
}

function applyAction(outcome: RuleOutcome, action: Action): void {
  const s = outcome.subject;
  switch (action.type) {
    case "setCategory": s.categoryId = action.categoryId; break;
    case "setPayee": s.payee = action.payee; break;
    case "setMemo":
      s.memo =
        action.mode === "prepend" ? `${action.memo} ${s.memo ?? ""}`.trim()
        : action.mode === "append" ? `${s.memo ?? ""} ${action.memo}`.trim()
        : action.memo;
      break;
    case "addTag":
      if (!s.tags.some((t) => t.toLowerCase() === action.tag.toLowerCase())) s.tags.push(action.tag);
      break;
    case "removeTag":
      s.tags = s.tags.filter((t) => t.toLowerCase() !== action.tag.toLowerCase());
      break;
    case "setOwner": break; // Carried on the staged row, not the rule subject.
    case "setCleared": s.cleared = action.cleared; break;
    case "setAccount": s.accountId = action.accountId; break;
    case "setDate": s.date = action.date; break;
    case "splitFixed":
      outcome.splits = action.parts.map((p) => ({ categoryId: p.categoryId, amount: p.amount }));
      s.categoryId = null;
      break;
    case "splitPercent": {
      // Percentages must still land on exact paise, so the last part takes the
      // remainder rather than everything being rounded independently.
      let assigned = 0;
      outcome.splits = action.parts.map((p, i) => {
        const amount =
          i === action.parts.length - 1
            ? s.amount - assigned
            : Math.round((s.amount * p.percent) / 100);
        assigned += amount;
        return { categoryId: p.categoryId, amount };
      });
      s.categoryId = null;
      break;
    }
    case "markForReview": outcome.markedForReview = true; break;
    case "markAutoApprovable": outcome.autoApprovable = true; break;
    case "ignore": outcome.ignored = true; break;
  }
}

/**
 * `04` §6.5 · The auto-approve gate.
 *
 * Every condition must hold. Auto-approval is off by default and earned per
 * payee, never granted globally.
 */
export function mayAutoApprove(
  outcome: RuleOutcome,
  opts: { payeeExists: boolean; duplicateSuspected: boolean },
): boolean {
  return (
    outcome.autoApprovable &&
    opts.payeeExists &&
    (outcome.subject.categoryId !== null || outcome.splits !== null) &&
    !opts.duplicateSuspected &&
    !outcome.markedForReview
  );
}

/**
 * F6.7 · Test a rule against historical transactions before saving, with a
 * before/after preview and a match count.
 */
export function testRule(
  rule: Rule,
  subjects: RuleSubject[],
): { matched: number; samples: { before: RuleSubject; after: RuleSubject }[] } {
  const samples: { before: RuleSubject; after: RuleSubject }[] = [];
  let matched = 0;
  for (const subject of subjects) {
    if (!ruleMatches(subject, rule)) continue;
    matched++;
    if (samples.length < 10) {
      samples.push({ before: subject, after: applyRules(subject, [rule]).subject });
    }
  }
  return { matched, samples };
}
