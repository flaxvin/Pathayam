/**
 * INSURANCE-1 · The household's insurance policies.
 *
 * Insurance had been a starter envelope (`starting-budget.ts`) and two figures
 * typed on the tax page. Neither knows that the term policy renews on the 12th
 * of March, that the car's cover lapses in June, or that the ₹38,000 in 80D is
 * three health premiums of which one is for parents. A register of policies
 * does, and the rest follows from it: the renewal shows in Overview's "Due
 * soon", and the tax page can offer what the policies add up to.
 *
 * Three things it deliberately does not do:
 *
 *   · **Post a transaction.** Marking a premium paid moves the next due date
 *     on by the policy's frequency and nothing else. The money went out of an
 *     account in the register already, on whatever day the bank says, and a
 *     second, invented copy of it would be worse than none.
 *   · **Keep the policy number.** Only its last four characters, which tell two
 *     policies from one insurer apart and match a premium notice. The whole
 *     number with a name and a date of birth is what an insurer asks for to
 *     change a nominee or start a claim; this database is not encrypted field
 *     by field (`08` S9) and its export travels.
 *   · **Decide the tax.** The tax page shows what the premiums falling due in a
 *     year come to, per group, beside the figures the member typed. Applying
 *     them is the member's choice, and fills the form rather than saving it.
 *
 * Ownership is the accounts rule (docs/privacy.md): a policy is the
 * household's, or one member's; a private one is its holder's alone, and
 * `memberScope` hides it from everybody else — the list, its URL, the activity
 * log and the export alike.
 */

import type { DB } from "../db/db.ts";
import { newId, transact, queryAll, queryOne, execute } from "../db/db.ts";
import { appendEvent, registerUndoHandler, type Actor } from "../core/events.ts";
import {
  nowIST, todayIST, isIsoDate, addMonths, monthOf, monthsBetween, daysInMonth,
  fiscalYearRange, type IsoDate,
} from "../core/dates.ts";
import { formatPaise, type Paise } from "../core/money.ts";
import { Missing, Refusal } from "../core/refusal.ts";
import { householdBudgetId, personalBudgetFor } from "./budgets.ts";

export const POLICY_KINDS = ["term-life", "life", "health", "vehicle", "home", "other"] as const;
export type PolicyKind = (typeof POLICY_KINDS)[number];

export const PREMIUM_FREQUENCIES = ["monthly", "quarterly", "half-yearly", "yearly", "single"] as const;
export type PremiumFrequency = (typeof PREMIUM_FREQUENCIES)[number];

export const TAX_GROUPS = ["none", "80c", "80d-self", "80d-parents"] as const;
export type TaxGroup = (typeof TAX_GROUPS)[number];

export type PolicyStatus = "active" | "lapsed" | "ended";

export const KIND_LABELS: Record<PolicyKind, string> = {
  "term-life": "Term life",
  life: "Other life or endowment",
  health: "Health",
  vehicle: "Vehicle",
  home: "Home",
  other: "Other",
};

export const FREQUENCY_LABELS: Record<PremiumFrequency, string> = {
  monthly: "Monthly",
  quarterly: "Quarterly",
  "half-yearly": "Half-yearly",
  yearly: "Yearly",
  single: "Single premium",
};

export const TAX_GROUP_LABELS: Record<TaxGroup, string> = {
  none: "None",
  "80c": "80C",
  "80d-self": "80D — yourself, spouse and children",
  "80d-parents": "80D — parents",
};

/** Months between two premiums. A single premium has no next one. */
const STEP_MONTHS: Record<PremiumFrequency, number | null> = {
  monthly: 1, quarterly: 3, "half-yearly": 6, yearly: 12, single: null,
};

export interface Policy {
  id: string;
  insurer: string;
  kind: PolicyKind;
  /** The last four characters of the policy number, never the whole of it. */
  policy_last4: string | null;
  sum_assured: Paise | null;
  premium: Paise;
  frequency: PremiumFrequency;
  /** The next premium or renewal. Null once nothing more falls due. */
  next_due: IsoDate | null;
  start_date: IsoDate | null;
  end_date: IsoDate | null;
  nominee: string | null;
  /** Who it covers, in words — parents are usually not members. */
  covered: string | null;
  tax_group: TaxGroup;
  /** 80D's higher ceiling: somebody this group covers is a senior citizen. */
  senior: number;
  category_id: string | null;
  holder_member_id: string | null;
  visibility: "household" | "private";
  status: PolicyStatus;
  /** When it lapsed or ended, if it has. */
  closed_on: IsoDate | null;
  note: string | null;
  created_at: string;
  created_by: string | null;
  updated_at: string;
  deleted_at: string | null;
}

export interface PolicyInput {
  insurer: string;
  kind: string;
  /** Whatever was typed; only its last four letters and digits are kept. */
  policyNumber?: string | null;
  sumAssured?: Paise | null;
  premium: Paise;
  frequency: string;
  nextDue?: IsoDate | null;
  startDate?: IsoDate | null;
  endDate?: IsoDate | null;
  nominee?: string | null;
  covered?: string | null;
  taxGroup?: string | null;
  senior?: boolean;
  categoryId?: string | null;
  holderMemberId?: string | null;
  visibility?: "household" | "private";
  note?: string | null;
}

/**
 * The last four letters or digits of a policy number, upper-cased. Spaces,
 * slashes and dashes are how insurers print them and carry nothing.
 */
export function lastFour(raw: string | null | undefined): string | null {
  const plain = String(raw ?? "").replace(/[^0-9A-Za-z]/g, "").toUpperCase();
  return plain ? plain.slice(-4) : null;
}

const text = (v: string | null | undefined): string | null => {
  const t = String(v ?? "").trim();
  return t ? t : null;
};

function validated(db: DB, input: PolicyInput) {
  const insurer = text(input.insurer);
  if (!insurer) throw new Refusal("Say who the insurer is.");
  if (!(POLICY_KINDS as readonly string[]).includes(input.kind)) throw new Refusal("Pick what kind of policy it is.");
  const kind = input.kind as PolicyKind;
  if (!(PREMIUM_FREQUENCIES as readonly string[]).includes(input.frequency)) {
    throw new Refusal("Pick how often the premium is paid.");
  }
  const frequency = input.frequency as PremiumFrequency;
  if (!Number.isInteger(input.premium) || input.premium <= 0) {
    throw new Refusal("Enter the premium, greater than zero.");
  }
  if (input.sumAssured !== undefined && input.sumAssured !== null
      && (!Number.isInteger(input.sumAssured) || input.sumAssured < 0)) {
    throw new Refusal("The sum assured cannot be negative.");
  }
  for (const [label, d] of [["The next due date", input.nextDue], ["The start date", input.startDate],
    ["The end date", input.endDate]] as const) {
    if (d && !isIsoDate(d)) throw new Refusal(`${label} is not a date.`);
  }
  if (input.startDate && input.endDate && input.endDate < input.startDate) {
    throw new Refusal("The policy cannot end before it starts.");
  }

  const taxGroup = (input.taxGroup || "none") as TaxGroup;
  if (!(TAX_GROUPS as readonly string[]).includes(taxGroup)) throw new Refusal("Pick a tax group, or none.");
  /*
   * 80C counts life cover and 80D health cover; a car's premium counts toward
   * neither, and filing it there would put it in a suggestion the tax page then
   * offers as a deduction. "Other" is left open: a critical-illness policy is
   * 80D, and a pension plan from a life insurer is 80C.
   */
  if (taxGroup === "80c" && !["term-life", "life", "other"].includes(kind)) {
    throw new Refusal("Only a life policy's premium counts toward 80C.");
  }
  if ((taxGroup === "80d-self" || taxGroup === "80d-parents") && !["health", "other"].includes(kind)) {
    throw new Refusal("Only a health policy's premium counts toward 80D.");
  }
  const senior = taxGroup.startsWith("80d") && input.senior === true;

  const holder = input.holderMemberId ?? null;
  const visibility = input.visibility ?? "household";
  if (visibility === "private" && !holder) {
    throw new Refusal("A private policy needs somebody to hold it — say whose it is.");
  }

  /*
   * The envelope it is paid from lives where the policy does. A shared policy
   * paid from somebody's own envelope would name that envelope to people who
   * cannot see it; a private one may use the household's or its holder's own.
   */
  const categoryId = input.categoryId ?? null;
  if (categoryId) {
    const envelope = queryOne<{ budget_id: string | null }>(
      db, `SELECT budget_id FROM categories WHERE id = ?`, categoryId,
    );
    if (!envelope) throw new Missing("That envelope does not exist.");
    const household = householdBudgetId(db);
    const own = holder && visibility === "private" ? personalBudgetFor(db, holder)?.id ?? null : null;
    if (envelope.budget_id !== null && envelope.budget_id !== household && envelope.budget_id !== own) {
      throw new Refusal(
        visibility === "private"
          ? "A private policy can be paid from a household envelope or its holder's own."
          : "A shared policy is paid from a household envelope.",
      );
    }
  }

  return {
    insurer, kind, frequency, taxGroup, senior, holder, visibility, categoryId,
    policyLast4: lastFour(input.policyNumber),
    sumAssured: input.sumAssured ?? null,
    premium: input.premium,
    // A single premium is paid once, at the start: there is nothing to come.
    nextDue: input.nextDue || null,
    startDate: input.startDate || null,
    endDate: input.endDate || null,
    nominee: text(input.nominee),
    covered: text(input.covered),
    note: text(input.note),
  };
}

export function getPolicy(db: DB, id: string): Policy | null {
  return queryOne<Policy>(db, `SELECT * FROM insurance_policies WHERE id = ? AND deleted_at IS NULL`, id);
}

/** The visibility predicate, the same everywhere (docs/privacy.md). */
const VISIBLE = `(p.visibility <> 'private' OR p.holder_member_id IS ?)`;

/**
 * Policies a viewer may see, active first. `viewerMemberId` undefined is the
 * operator's whole-household read; null is nobody in particular.
 */
export function listPolicies(db: DB, opts: { viewerMemberId?: string | null } = {}): Policy[] {
  const where = ["p.deleted_at IS NULL"];
  const params: (string | null)[] = [];
  if (opts.viewerMemberId !== undefined) {
    where.push(VISIBLE);
    params.push(opts.viewerMemberId);
  }
  return queryAll<Policy>(
    db,
    `SELECT p.* FROM insurance_policies p WHERE ${where.join(" AND ")}
      ORDER BY p.status <> 'active', p.next_due IS NULL, p.next_due, p.insurer`,
    ...params,
  );
}

/** Whether this viewer may see this policy at all. */
export function canSeePolicy(db: DB, id: string, viewerMemberId: string | null): boolean {
  return queryOne(
    db,
    `SELECT 1 FROM insurance_policies p WHERE p.id = ? AND p.deleted_at IS NULL AND ${VISIBLE}`,
    id, viewerMemberId,
  ) !== null;
}

/**
 * Whether a policy is still running. A lapsed or ended one is kept, and shown
 * apart; so is one whose end date has passed without anybody saying so.
 */
export function isCurrent(p: Policy, today: IsoDate = todayIST()): boolean {
  return p.status === "active" && !(p.end_date && p.end_date < today);
}

function snapshot(db: DB, id: string): Policy {
  return queryOne<Policy>(db, `SELECT * FROM insurance_policies WHERE id = ?`, id)!;
}

function describe(p: { insurer: string; kind: PolicyKind; policyLast4?: string | null; policy_last4?: string | null }): string {
  const tail = p.policyLast4 ?? p.policy_last4;
  return `${p.insurer} ${KIND_LABELS[p.kind].toLowerCase()} policy${tail ? ` ending ${tail}` : ""}`;
}

export function createPolicy(db: DB, actor: Actor, input: PolicyInput): Policy {
  return transact(db, () => {
    const v = validated(db, input);
    const id = newId();
    const now = nowIST();
    execute(
      db,
      `INSERT INTO insurance_policies
         (id, insurer, kind, policy_last4, sum_assured, premium, frequency, next_due,
          start_date, end_date, nominee, covered, tax_group, senior, category_id,
          holder_member_id, visibility, status, closed_on, note, created_at, created_by, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'active',NULL,?,?,?,?)`,
      id, v.insurer, v.kind, v.policyLast4, v.sumAssured, v.premium, v.frequency, v.nextDue,
      v.startDate, v.endDate, v.nominee, v.covered, v.taxGroup, v.senior ? 1 : 0, v.categoryId,
      v.holder, v.visibility, v.note, now, actor.memberId, now,
    );
    const after = snapshot(db, id);
    appendEvent(db, actor, {
      entity: "insurance-policy", entityId: id, action: "create", after,
      summary: `Added the ${describe(v)}`,
    });
    return after;
  });
}

export function updatePolicy(db: DB, actor: Actor, id: string, input: PolicyInput): Policy {
  return transact(db, () => {
    const before = getPolicy(db, id);
    if (!before) throw new Missing("That policy does not exist.");
    const v = validated(db, input);
    execute(
      db,
      `UPDATE insurance_policies
          SET insurer = ?, kind = ?, policy_last4 = COALESCE(?, policy_last4), sum_assured = ?,
              premium = ?, frequency = ?, next_due = ?, start_date = ?, end_date = ?,
              nominee = ?, covered = ?, tax_group = ?, senior = ?, category_id = ?,
              holder_member_id = ?, visibility = ?, note = ?, updated_at = ?
        WHERE id = ?`,
      v.insurer, v.kind, v.policyLast4, v.sumAssured, v.premium, v.frequency, v.nextDue,
      v.startDate, v.endDate, v.nominee, v.covered, v.taxGroup, v.senior ? 1 : 0, v.categoryId,
      v.holder, v.visibility, v.note, nowIST(), id,
    );
    const after = snapshot(db, id);
    appendEvent(db, actor, {
      entity: "insurance-policy", entityId: id, action: "update", before, after,
      summary: `Changed the ${describe(after)}`,
    });
    return after;
  });
}

/** `date` moved on `months` calendar months, landing on `day` or the month's last day. */
function shiftMonths(date: IsoDate, months: number, day: number): IsoDate {
  const month = addMonths(monthOf(date), months);
  const last = daysInMonth(Number(month.slice(0, 4)), Number(month.slice(5)));
  return `${month}-${String(Math.min(day, last)).padStart(2, "0")}`;
}

/**
 * The day of the month premiums fall on. Usually the due date's own; but a
 * policy that started on the 31st and was paid in February is due on the 28th
 * once and on the 31st again after, not on the 28th for ever.
 */
function dueDay(p: Pick<Policy, "next_due" | "start_date">): number {
  const anchor = p.next_due ?? p.start_date!;
  const own = Number(anchor.slice(8, 10));
  if (!p.start_date) return own;
  const start = Number(p.start_date.slice(8, 10));
  const lastOfMonth = daysInMonth(Number(anchor.slice(0, 4)), Number(anchor.slice(5, 7)));
  return own === lastOfMonth && start > own ? start : own;
}

/**
 * The due date after `p.next_due`, or null when nothing more falls due: a
 * single premium, or a policy whose end date comes first.
 */
export function followingDue(p: Pick<Policy, "next_due" | "start_date" | "end_date" | "frequency">): IsoDate | null {
  const step = STEP_MONTHS[p.frequency];
  if (!p.next_due || step === null) return null;
  const next = shiftMonths(p.next_due, step, dueDay(p));
  if (p.end_date && next >= p.end_date) return null;
  return next;
}

/**
 * Every premium date of a policy between `from` and `to`, inclusive.
 *
 * Counted from the next due date, backwards and forwards by the frequency, and
 * only within the policy's own life: nothing before it started, nothing on or
 * after its end date (cover that ends on a day is not renewed on it), and
 * nothing after the day it lapsed or ended. A single premium is the one date it
 * was paid — the start, or the due date if no start was given.
 */
export function premiumDatesBetween(
  p: Pick<Policy, "next_due" | "start_date" | "end_date" | "frequency" | "closed_on" | "status">,
  from: IsoDate, to: IsoDate,
): IsoDate[] {
  const inLife = (d: IsoDate) =>
    d >= from && d <= to
    && (!p.start_date || d >= p.start_date)
    && (!p.end_date || d < p.end_date)
    && (p.status === "active" || !p.closed_on || d <= p.closed_on);

  const step = STEP_MONTHS[p.frequency];
  if (step === null) {
    const once = p.start_date ?? p.next_due;
    return once && (once >= from && once <= to)
      && (p.status === "active" || !p.closed_on || once <= p.closed_on) ? [once] : [];
  }
  const anchor = p.next_due ?? p.start_date;
  if (!anchor) return [];
  const day = dueDay({ next_due: anchor, start_date: p.start_date });
  const lo = Math.floor(monthsBetween(monthOf(anchor), monthOf(from)) / step) - 1;
  const hi = Math.ceil(monthsBetween(monthOf(anchor), monthOf(to)) / step) + 1;
  const dates: IsoDate[] = [];
  for (let k = lo; k <= hi; k++) {
    const d = shiftMonths(anchor, k * step, day);
    if (inLife(d)) dates.push(d);
  }
  return dates;
}

/**
 * A premium or renewal paid: the next due date moves on by the frequency.
 *
 * Nothing is posted. The payment is in the register already, or will be when
 * the statement is imported; this only records that the policy is paid up to
 * its next date. A single premium, or the last one before the end date, leaves
 * nothing due.
 */
export function markPremiumPaid(db: DB, actor: Actor, id: string): IsoDate | null {
  return transact(db, () => {
    const before = getPolicy(db, id);
    if (!before) throw new Missing("That policy does not exist.");
    if (!before.next_due) throw new Refusal("Nothing is due on this policy.");
    if (before.status !== "active") throw new Refusal("This policy is not active; nothing is due on it.");
    const next = followingDue(before);
    execute(
      db, `UPDATE insurance_policies SET next_due = ?, updated_at = ? WHERE id = ?`,
      next, nowIST(), id,
    );
    appendEvent(db, actor, {
      entity: "insurance-policy", entityId: id, action: "paid", before, after: snapshot(db, id),
      summary: `Paid the ${formatPaise(before.premium)} premium on the ${describe(before)}`
        + (next ? `; next due ${next}` : "; nothing more falls due"),
    });
    return next;
  });
}

/**
 * Lapsed, ended, or running again. A lapsed or ended policy is kept, with the
 * day it stopped, and shown apart; nothing falls due on it.
 */
export function setPolicyStatus(
  db: DB, actor: Actor, id: string, status: PolicyStatus, on: IsoDate = todayIST(),
): void {
  transact(db, () => {
    const before = getPolicy(db, id);
    if (!before) throw new Missing("That policy does not exist.");
    if (!["active", "lapsed", "ended"].includes(status)) throw new Refusal("That is not a policy status.");
    if (before.status === status) return;
    execute(
      db,
      `UPDATE insurance_policies SET status = ?, closed_on = ?, updated_at = ? WHERE id = ?`,
      status, status === "active" ? null : on, nowIST(), id,
    );
    const words = status === "active" ? "Reinstated" : status === "lapsed" ? "Marked lapsed" : "Marked ended";
    appendEvent(db, actor, {
      entity: "insurance-policy", entityId: id, action: "status", before, after: snapshot(db, id),
      summary: `${words}: the ${describe(before)}`,
    });
  });
}

/** Removed from every list. The row stays, so an undo has it and it stays private. */
export function deletePolicy(db: DB, actor: Actor, id: string): void {
  transact(db, () => {
    const before = getPolicy(db, id);
    if (!before) throw new Missing("That policy does not exist.");
    execute(db, `UPDATE insurance_policies SET deleted_at = ?, updated_at = ? WHERE id = ?`, nowIST(), nowIST(), id);
    appendEvent(db, actor, {
      entity: "insurance-policy", entityId: id, action: "delete", before, after: snapshot(db, id),
      summary: `Deleted the ${describe(before)}`,
    });
  });
}

/*
 * Every event carries the whole row before and after, so an undo puts back
 * exactly what was there: an edit, a premium marked paid, a lapse, a delete.
 * Undoing the create removes it the way a delete does.
 */
registerUndoHandler("insurance-policy", (db, event) => {
  const before = event.before as Policy | undefined;
  if (!before) {
    execute(db, `UPDATE insurance_policies SET deleted_at = ?, updated_at = ? WHERE id = ?`,
      nowIST(), nowIST(), event.entityId!);
    return "Removed the policy that was added";
  }
  execute(
    db,
    `UPDATE insurance_policies
        SET insurer = ?, kind = ?, policy_last4 = ?, sum_assured = ?, premium = ?, frequency = ?,
            next_due = ?, start_date = ?, end_date = ?, nominee = ?, covered = ?, tax_group = ?,
            senior = ?, category_id = ?, holder_member_id = ?, visibility = ?, status = ?,
            closed_on = ?, note = ?, deleted_at = ?, updated_at = ?
      WHERE id = ?`,
    before.insurer, before.kind, before.policy_last4, before.sum_assured, before.premium,
    before.frequency, before.next_due, before.start_date, before.end_date, before.nominee,
    before.covered, before.tax_group, before.senior, before.category_id, before.holder_member_id,
    before.visibility, before.status, before.closed_on, before.note, before.deleted_at, nowIST(),
    event.entityId!,
  );
  return `Put back the ${describe(before)} as it was`;
});

export interface PolicyDue {
  id: string;
  name: string;
  amount: Paise;
  nextDue: IsoDate;
}

/**
 * Premiums and renewals due on or before `until`, for Overview's "Due soon".
 *
 * Only what the viewer can see, only running policies, and only those that
 * belong to the budget being looked at: the envelope a policy is paid from
 * decides, and without one a private policy is its holder's budget's and any
 * other the household's. An overdue premium is included — it is the most due
 * of all.
 */
export function policiesDueBy(
  db: DB, opts: { viewerMemberId: string | null; until: IsoDate; budgetId: string; today?: IsoDate },
): PolicyDue[] {
  const today = opts.today ?? todayIST();
  const household = householdBudgetId(db);
  const envelopeBudget = new Map(
    queryAll<{ id: string; budget_id: string | null }>(db, `SELECT id, budget_id FROM categories`)
      .map((c) => [c.id, c.budget_id ?? household]),
  );
  return listPolicies(db, { viewerMemberId: opts.viewerMemberId })
    .filter((p) => isCurrent(p, today) && p.next_due && p.next_due <= opts.until)
    .filter((p) => {
      const viaEnvelope = p.category_id ? envelopeBudget.get(p.category_id) : undefined;
      if (viaEnvelope) return viaEnvelope === opts.budgetId;
      const own = p.visibility === "private" && p.holder_member_id
        ? personalBudgetFor(db, p.holder_member_id)?.id ?? household
        : household;
      return own === opts.budgetId;
    })
    .map((p) => ({
      id: p.id,
      name: `${p.insurer} · ${KIND_LABELS[p.kind]}${p.policy_last4 ? ` ··${p.policy_last4}` : ""}`,
      amount: p.premium,
      nextDue: p.next_due!,
    }));
}

export interface PolicyTaxSuggestion {
  s80c: Paise;
  s80d: Paise;
  s80dParents: Paise;
  s80dSenior: boolean;
  s80dParentsSenior: boolean;
  /** Each policy that contributed, so the page can say where a figure came from. */
  lines: { id: string; name: string; group: TaxGroup; premiums: number; amount: Paise }[];
}

/**
 * What a member's policies put toward 80C and 80D in financial year `fy`.
 *
 * The premiums falling due in the year, each counted once — paid or not yet,
 * since a year in progress is the one being planned. Only policies this member
 * holds: tax is assessed on whoever pays, and a household policy held by
 * nobody is not anybody's deduction until somebody is named as its holder.
 *
 * A suggestion, not a declaration. It does not know about the part of a
 * multi-year health premium the Act spreads across years, or a premium paid in
 * cash (which 80D does not allow), and the page says so.
 */
export function policyTaxSuggestion(db: DB, memberId: string, fy: number): PolicyTaxSuggestion {
  const { from, to } = fiscalYearRange(fy);
  const out: PolicyTaxSuggestion = {
    s80c: 0 as Paise, s80d: 0 as Paise, s80dParents: 0 as Paise,
    s80dSenior: false, s80dParentsSenior: false, lines: [],
  };
  const held = queryAll<Policy>(
    db,
    `SELECT * FROM insurance_policies
      WHERE deleted_at IS NULL AND holder_member_id = ? AND tax_group <> 'none'
      ORDER BY insurer`,
    memberId,
  );
  for (const p of held) {
    const premiums = premiumDatesBetween(p, from, to).length;
    if (premiums === 0) continue;
    const amount = (premiums * p.premium) as Paise;
    if (p.tax_group === "80c") out.s80c = (out.s80c + amount) as Paise;
    if (p.tax_group === "80d-self") {
      out.s80d = (out.s80d + amount) as Paise;
      out.s80dSenior ||= p.senior === 1;
    }
    if (p.tax_group === "80d-parents") {
      out.s80dParents = (out.s80dParents + amount) as Paise;
      out.s80dParentsSenior ||= p.senior === 1;
    }
    out.lines.push({ id: p.id, name: describe(p), group: p.tax_group, premiums, amount });
  }
  return out;
}

/**
 * The tax form's figures with the policies' applied: each raised to what the
 * policies come to, never lowered. 80C also holds PF, ELSS and tuition, and an
 * 80D figure can include a senior's medical bills, so a typed figure above the
 * policies' is kept; a senior box is ticked, never unticked.
 */
export function applyPolicySuggestion<T extends {
  s80c: Paise; s80d: Paise; s80dParents?: Paise; s80dSenior: boolean; s80dParentsSenior?: boolean;
}>(typed: T, s: PolicyTaxSuggestion): T {
  return {
    ...typed,
    s80c: Math.max(typed.s80c, s.s80c) as Paise,
    s80d: Math.max(typed.s80d, s.s80d) as Paise,
    s80dParents: Math.max(typed.s80dParents ?? 0, s.s80dParents) as Paise,
    s80dSenior: typed.s80dSenior || s.s80dSenior,
    s80dParentsSenior: (typed.s80dParentsSenior ?? false) || s.s80dParentsSenior,
  };
}
