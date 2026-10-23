/**
 * INSURANCE-1 · The policy register: what is due when, what marking a premium
 * paid does (and does not), who sees a policy, and what the policies put
 * toward 80C and 80D in a year.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { rupees, type Paise } from "../core/money.ts";
import { undoEvent, queryEvents, type Actor } from "../core/events.ts";
import { queryValue } from "../db/db.ts";
import { freshDb, seedMember } from "../web/harness.test-data.ts";
import {
  createPolicy, updatePolicy, markPremiumPaid, setPolicyStatus, deletePolicy, getPolicy,
  listPolicies, canSeePolicy, followingDue, premiumDatesBetween, policiesDueBy,
  policyTaxSuggestion, applyPolicySuggestion, lastFour, type PolicyInput,
} from "./insurance.ts";
import { memberScope } from "./member-scope.ts";
import { eventVisibility } from "./event-visibility.ts";
import { exportForMember } from "../ops/member-export.ts";
import { ensurePersonalBudget, householdBudgetId } from "./budgets.ts";
import { createGroup, createCategory } from "./budget.ts";

const RAVI = "m-ravi";
const PRIYA = "m-priya";
const ravi: Actor = { memberId: RAVI, source: "ui" };

function household() {
  const db = freshDb();
  seedMember(db, RAVI, "Ravi");
  seedMember(db, PRIYA, "Priya");
  return db;
}

const term = (over: Partial<PolicyInput> = {}): PolicyInput => ({
  insurer: "Fictional Life", kind: "term-life", premium: rupees(18_000) as Paise,
  frequency: "yearly", nextDue: "2027-03-12", startDate: "2020-03-12", endDate: "2050-03-12",
  taxGroup: "80c", holderMemberId: RAVI, ...over,
});

describe("INSURANCE-1 · due dates", () => {
  const base = { start_date: null, end_date: null } as const;

  test("each frequency moves the date on by its own step", () => {
    const cases: [string, string][] = [
      ["monthly", "2026-12-05"], ["quarterly", "2027-02-05"],
      ["half-yearly", "2027-05-05"], ["yearly", "2027-11-05"],
    ];
    for (const [frequency, expected] of cases) {
      assert.equal(
        followingDue({ ...base, next_due: "2026-11-05", frequency: frequency as never }), expected, frequency,
      );
    }
  });

  test("a single premium, or the last before the end date, leaves nothing due", () => {
    assert.equal(followingDue({ ...base, next_due: "2026-11-05", frequency: "single" }), null);
    assert.equal(
      followingDue({ next_due: "2026-11-05", start_date: null, end_date: "2027-11-05", frequency: "yearly" }),
      null,
    );
  });

  test("a policy started on the 31st comes back to the 31st after February", () => {
    const p = { next_due: "2027-01-31", start_date: "2026-01-31", end_date: null, frequency: "monthly" as const };
    const feb = followingDue(p)!;
    assert.equal(feb, "2027-02-28");
    assert.equal(followingDue({ ...p, next_due: feb }), "2027-03-31");
  });

  test("premium dates in a year count backwards and forwards, inside the policy's life", () => {
    const quarterly = {
      next_due: "2026-11-15", start_date: "2026-05-15", end_date: null,
      frequency: "quarterly" as const, closed_on: null, status: "active" as const,
    };
    // FY 2026-27: 15 May (start), 15 Aug, 15 Nov, 15 Feb.
    assert.deepEqual(premiumDatesBetween(quarterly, "2026-04-01", "2027-03-31"),
      ["2026-05-15", "2026-08-15", "2026-11-15", "2027-02-15"]);
    // Lapsed on 1 December: nothing after.
    assert.deepEqual(
      premiumDatesBetween({ ...quarterly, status: "lapsed", closed_on: "2026-12-01" }, "2026-04-01", "2027-03-31"),
      ["2026-05-15", "2026-08-15", "2026-11-15"],
    );
  });

  test("only the last four of a policy number are kept", () => {
    assert.equal(lastFour("POL/123-456 7890"), "7890");
    assert.equal(lastFour("ab1"), "AB1");
    assert.equal(lastFour("  "), null);
  });
});

describe("INSURANCE-1 · the register", () => {
  test("a policy keeps the last four of its number, and refuses what does not fit", () => {
    const db = household();
    const p = createPolicy(db, ravi, term({ policyNumber: "LIC 0042 9876 5432" }));
    assert.equal(p.policy_last4, "5432");
    assert.equal(
      queryValue<number>(db, `SELECT COUNT(*) FROM insurance_policies WHERE policy_last4 LIKE '%9876%'`), 0,
    );
    assert.throws(() => createPolicy(db, ravi, term({ kind: "vehicle", taxGroup: "80c" })), /80C/);
    assert.throws(() => createPolicy(db, ravi, term({ kind: "term-life", taxGroup: "80d-self" })), /80D/);
    assert.throws(() => createPolicy(db, ravi, term({ premium: 0 as Paise })), /premium/);
    assert.throws(() => createPolicy(db, ravi, term({ visibility: "private", holderMemberId: null })), /holder|whose/);
    assert.throws(() => createPolicy(db, ravi, term({ endDate: "2019-01-01" })), /end before/);
  });

  test("marking paid moves the due date and posts nothing; undo puts it back", () => {
    const db = household();
    const p = createPolicy(db, ravi, term());
    const before = queryValue<number>(db, `SELECT COUNT(*) FROM transactions`);
    assert.equal(markPremiumPaid(db, ravi, p.id), "2028-03-12");
    assert.equal(getPolicy(db, p.id)!.next_due, "2028-03-12");
    assert.equal(queryValue<number>(db, `SELECT COUNT(*) FROM transactions`), before, "no transaction posted");

    const paid = queryEvents(db, { entity: "insurance-policy" }).find((e) => e.action === "paid")!;
    assert.ok(undoEvent(db, paid.id, ravi).ok);
    assert.equal(getPolicy(db, p.id)!.next_due, "2027-03-12");
  });

  test("lapsed and ended policies are kept; nothing is due on them", () => {
    const db = household();
    const p = createPolicy(db, ravi, term());
    setPolicyStatus(db, ravi, p.id, "lapsed", "2026-10-01");
    const kept = getPolicy(db, p.id)!;
    assert.equal(kept.status, "lapsed");
    assert.equal(kept.closed_on, "2026-10-01");
    assert.throws(() => markPremiumPaid(db, ravi, p.id), /not active/);
    assert.equal(listPolicies(db, { viewerMemberId: RAVI }).length, 1, "still listed");
  });

  test("an edit and a delete both undo", () => {
    const db = household();
    const p = createPolicy(db, ravi, term());
    updatePolicy(db, ravi, p.id, term({ insurer: "Renamed Life" }));
    const edit = queryEvents(db, { entity: "insurance-policy" }).find((e) => e.action === "update")!;
    assert.ok(undoEvent(db, edit.id, ravi).ok);
    assert.equal(getPolicy(db, p.id)!.insurer, "Fictional Life");

    deletePolicy(db, ravi, p.id);
    assert.equal(getPolicy(db, p.id), null);
    const del = queryEvents(db, { entity: "insurance-policy" }).find((e) => e.action === "delete")!;
    assert.ok(undoEvent(db, del.id, ravi).ok);
    assert.ok(getPolicy(db, p.id), "back again");
  });

  test("a shared policy cannot be paid from somebody's own envelope", () => {
    const db = household();
    const his = ensurePersonalBudget(db, RAVI, "Ravi");
    const group = createGroup(db, ravi, "Mine", "normal", his.id);
    const own = createCategory(db, ravi, { groupId: group.id, name: "Ravi's premiums" });
    assert.throws(() => createPolicy(db, ravi, term({ categoryId: own.id })), /household envelope/);
    const mine = createPolicy(db, ravi, term({ categoryId: own.id, visibility: "private" }));
    assert.equal(mine.category_id, own.id);
  });
});

describe("INSURANCE-1 · a private policy is its holder's alone", () => {
  test("hidden from the list, the id check, the activity log and the export", () => {
    const db = household();
    const secret = createPolicy(db, ravi, term({ insurer: "Basilisk Assurance", visibility: "private" }));
    const shared = createPolicy(db, ravi, term({ insurer: "Joint Health Co", kind: "health", taxGroup: "80d-self" }));

    assert.deepEqual(listPolicies(db, { viewerMemberId: PRIYA }).map((p) => p.id), [shared.id]);
    assert.equal(canSeePolicy(db, secret.id, PRIYA), false);
    assert.equal(canSeePolicy(db, secret.id, RAVI), true);
    assert.ok(memberScope(db, PRIYA).hides(secret.id));

    const canSee = eventVisibility(db, PRIYA);
    const events = queryEvents(db, { entity: "insurance-policy" });
    assert.equal(events.filter(canSee).length, 1, "only the shared policy's event");

    // Deleted, it stays private: the row is kept, so the delete event is judged by it.
    deletePolicy(db, ravi, secret.id);
    const after = eventVisibility(db, PRIYA);
    assert.ok(!queryEvents(db, { entity: "insurance-policy" }).some((e) => e.entityId === secret.id && after(e)));

    const exported = JSON.stringify(exportForMember(db, PRIYA));
    assert.ok(!exported.includes("Basilisk Assurance"), "not in Priya's export");
    assert.ok(exported.includes("Joint Health Co"), "the shared one is");
    assert.ok(JSON.stringify(exportForMember(db, RAVI)).includes("Basilisk Assurance"), "in Ravi's own");
  });
});

describe("INSURANCE-1 · due soon", () => {
  test("a premium due inside the horizon is listed, for the budget it belongs to", () => {
    const db = household();
    const household_ = householdBudgetId(db);
    const his = ensurePersonalBudget(db, RAVI, "Ravi");
    createPolicy(db, ravi, term({ insurer: "Soon Life", nextDue: "2026-10-30" }));
    createPolicy(db, ravi, term({ insurer: "Later Life", nextDue: "2026-12-30" }));
    createPolicy(db, ravi, term({ insurer: "Mine Life", nextDue: "2026-10-25", visibility: "private" }));
    const lapsed = createPolicy(db, ravi, term({ insurer: "Gone Life", nextDue: "2026-10-26" }));
    setPolicyStatus(db, ravi, lapsed.id, "lapsed");

    const due = (viewer: string, budgetId: string) => policiesDueBy(db, {
      viewerMemberId: viewer, until: "2026-11-05", budgetId, today: "2026-10-22",
    }).map((d) => d.name.split(" ·")[0]);

    assert.deepEqual(due(RAVI, household_), ["Soon Life"]);
    assert.deepEqual(due(RAVI, his.id), ["Mine Life"]);
    assert.deepEqual(due(PRIYA, his.id), [], "never another member's");
  });
});

describe("INSURANCE-1 · the tax suggestion", () => {
  test("premiums due in the year, per group, from the policies the member holds", () => {
    const db = household();
    createPolicy(db, ravi, term({ premium: rupees(12_000) as Paise, nextDue: "2026-06-01", startDate: "2020-06-01" }));
    createPolicy(db, ravi, {
      insurer: "Fictional Health", kind: "health", premium: rupees(2_000) as Paise,
      frequency: "monthly", nextDue: "2026-11-10", startDate: "2026-07-10",
      taxGroup: "80d-self", holderMemberId: RAVI,
    });
    createPolicy(db, ravi, {
      insurer: "Parents Health", kind: "health", premium: rupees(40_000) as Paise,
      frequency: "yearly", nextDue: "2027-01-20", taxGroup: "80d-parents", senior: true,
      holderMemberId: RAVI,
    });
    // Priya's, and the car's: neither is Ravi's deduction.
    createPolicy(db, ravi, term({ holderMemberId: PRIYA }));
    createPolicy(db, ravi, {
      insurer: "Car Co", kind: "vehicle", premium: rupees(9_000) as Paise,
      frequency: "yearly", nextDue: "2026-12-01", holderMemberId: RAVI,
    });

    const s = policyTaxSuggestion(db, RAVI, 2026);
    assert.equal(s.s80c, rupees(12_000));
    // July 2026 to March 2027: nine monthly premiums.
    assert.equal(s.s80d, rupees(18_000));
    assert.equal(s.s80dParents, rupees(40_000));
    assert.equal(s.s80dParentsSenior, true);
    assert.equal(s.s80dSenior, false);
    assert.equal(s.lines.length, 3);

    assert.equal(policyTaxSuggestion(db, PRIYA, 2026).s80c, rupees(18_000));
  });

  test("applying raises a figure to the policies', and never lowers one", () => {
    const s = {
      s80c: rupees(12_000) as Paise, s80d: rupees(18_000) as Paise, s80dParents: rupees(40_000) as Paise,
      s80dSenior: false, s80dParentsSenior: true, lines: [],
    };
    const applied = applyPolicySuggestion({
      s80c: rupees(1_50_000) as Paise, s80d: rupees(5_000) as Paise, s80dParents: 0 as Paise,
      s80dSenior: true, s80dParentsSenior: false,
    }, s);
    assert.equal(applied.s80c, rupees(1_50_000), "PF and ELSS are in 80C too: kept");
    assert.equal(applied.s80d, rupees(18_000));
    assert.equal(applied.s80dParents, rupees(40_000));
    assert.equal(applied.s80dSenior, true, "a tick is never taken away");
    assert.equal(applied.s80dParentsSenior, true);
  });
});
