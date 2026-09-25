/**
 * `04` §4 · Duplicate detection.
 *
 * "Duplicates are the failure mode that destroys trust fastest, and they are
 * guaranteed here: the same ₹450 Swiggy order can arrive as an SMS alert, an
 * email alert, and a line in the month-end statement."
 *
 * The two invariants that shape this module:
 *
 * - **I4 / N3** a suspected duplicate is never silently dropped. Only an exact
 *   source-id repeat is skipped, and that is idempotency (I5), not a duplicate.
 * - **D2** two genuinely identical transactions must be easy to keep. Two
 *   people at the same shop for the same amount on the same day is normal (H5),
 *   so every tier below `strong` asks rather than decides.
 */

import type { Paise } from "../core/money.ts";
import type { IsoDate } from "../core/dates.ts";
import { daysBetween } from "../core/dates.ts";

export type DuplicateTier = "exact" | "strong" | "probable" | "weak" | "manual-vs-imported";

export interface Candidate {
  id: string;
  accountId: string;
  date: IsoDate;
  amount: Paise;
  /** The cleaned payee, where one is known. */
  payee: string | null;
  reference: string | null;
  /** 'manual' for a hand-entered transaction; the adapter name otherwise. */
  source: string;
  sourceId: string | null;
}

export interface Incoming {
  accountId: string;
  date: IsoDate;
  amount: Paise;
  payee: string | null;
  reference: string | null;
  source: string;
  sourceId: string | null;
}

export interface DuplicateMatch {
  tier: DuplicateTier;
  existing: Candidate;
  /** Stated to the user beside the pair (S4 §2) — never just "duplicate". */
  reason: string;
  /**
   * What the review queue should suggest. `skip` and `upgrade` are applied
   * automatically; `ask` queues the pair for a decision.
   */
  action: "skip" | "upgrade" | "ask";
  /** Where `ask` applies, the pre-selected option (D4's manual-vs-imported case). */
  suggested?: "merge" | "keep-both";
}

/**
 * Normalise a payee for comparison. Deliberately aggressive: `SWIGGY*ORDER123`
 * and `Swiggy` are the same counterparty for dedupe purposes even though
 * payee *cleanup* (`04` §3.6) is a separate, never-silent concern.
 */
export function normalisePayee(payee: string | null): string {
  if (!payee) return "";
  return payee
    .toLowerCase()
    // MERCHANT*SUBMERCHANT is one counterparty, exactly as in merchant
    // extraction — otherwise "SWIGGY*ORDER" and "Swiggy" look like two payees
    // and the probable tier misses the duplicate it exists to catch.
    .replace(/\*.*$/, "")
    .replace(/\b(upi|imps|neft|rtgs|pos|ach|nach|ecs|emi)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b\d{4,}\b/g, " ") // reference numbers and order ids
    .trim()
    .split(/\s+/)
    .slice(0, 3)
    .join(" ");
}

/**
 * Find the best duplicate match for an incoming record, or null.
 *
 * Tiers are checked strongest first and the first hit wins, so a reference
 * match is never demoted to a fuzzy date match.
 */
export function findDuplicate(incoming: Incoming, candidates: Candidate[]): DuplicateMatch | null {
  const sameAccount = candidates.filter((c) => c.accountId === incoming.accountId);

  // I5: re-running the same import produces zero new transactions. This is
  // idempotency, not a duplicate, so it is skipped silently and by design.
  //
  // The source id already names its adapter ("hdfc:…", "csv:…"), so it is
  // compared alone. Comparing `source` too never matched a PDF or email row:
  // approval used to write every import as 'csv', so a Gmail alert fetched a
  // second time missed this tier, queued again, and then 500'd on the unique
  // index when approved — on every fetch.
  if (incoming.sourceId) {
    const exact = sameAccount.find((c) => c.sourceId === incoming.sourceId);
    if (exact) {
      return {
        tier: "exact",
        existing: exact,
        reason: "This exact row was already imported from this file.",
        action: "skip",
      };
    }
  }

  const sameAmount = sameAccount.filter((c) => c.amount === incoming.amount);

  // Strong: same account, same amount, same bank reference. Auto-linked and
  // logged, not queued — the reference is the bank's own identity for the
  // transaction, so this is the same event arriving twice.
  if (incoming.reference) {
    const strong = sameAmount.find(
      (c) => c.reference && c.reference === incoming.reference,
    );
    if (strong) {
      return {
        tier: "strong",
        existing: strong,
        reason: `Same amount and the same bank reference (${incoming.reference}).`,
        // D4: a statement arriving after an alert upgrades it rather than
        // duplicating it. This is the single most important dedupe behaviour
        // once P1 ships.
        action: "upgrade",
      };
    }
  }

  const incomingPayee = normalisePayee(incoming.payee);

  // Manual-vs-imported: a wider window, because someone typing at the counter
  // dates it today while the bank posts it days later.
  const manual = sameAmount.find(
    (c) => c.source === "manual" && Math.abs(daysBetween(c.date, incoming.date)) <= 5,
  );
  if (manual && incoming.source !== "manual") {
    return {
      tier: "manual-vs-imported",
      existing: manual,
      reason:
        `You entered ${describeAmount(incoming.amount)} by hand on ${manual.date}, ` +
        `and the bank has now sent the same amount.`,
      action: "ask",
      // The manual entry has the category you chose; the import has the
      // bank's payee and reference. Merging keeps the better half of each.
      suggested: "merge",
    };
  }

  // Probable: same amount, ±3 days, and the payee matches.
  const probable = sameAmount.find(
    (c) =>
      Math.abs(daysBetween(c.date, incoming.date)) <= 3 &&
      incomingPayee !== "" &&
      normalisePayee(c.payee) === incomingPayee,
  );
  if (probable) {
    return {
      tier: "probable",
      existing: probable,
      reason: `Same amount and payee, ${dayGap(probable.date, incoming.date)}.`,
      action: "ask",
      suggested: "merge",
    };
  }

  // Weak: same amount, ±1 day, no payee match. Queued at lower prominence,
  // because two people at the same restaurant is a normal Saturday (H5).
  const weak = sameAmount.find((c) => Math.abs(daysBetween(c.date, incoming.date)) <= 1);
  if (weak) {
    return {
      tier: "weak",
      existing: weak,
      reason: `Same amount, ${dayGap(weak.date, incoming.date)}, but a different payee.`,
      action: "ask",
      suggested: "keep-both",
    };
  }

  return null;
}

function dayGap(a: IsoDate, b: IsoDate): string {
  const days = Math.abs(daysBetween(a, b));
  if (days === 0) return "the same day";
  return `${days} day${days === 1 ? "" : "s"} apart`;
}

function describeAmount(amount: Paise): string {
  return `₹${Math.abs(amount / 100).toLocaleString("en-IN")}`;
}

/** How prominently the review queue should show a suspected pair (S4 §2). */
export function prominenceOf(tier: DuplicateTier): "high" | "low" {
  return tier === "weak" ? "low" : "high";
}
