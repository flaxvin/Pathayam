import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  extractNarrationFields, applyRules, orderRules, specificity, ruleMatches,
  mayAutoApprove, testRule, type Rule, type RuleSubject,
} from "./rules.ts";
import { findDuplicate, normalisePayee, type Candidate } from "./dedupe.ts";
import { rupees } from "../core/money.ts";

function subject(overrides: Partial<RuleSubject> = {}): RuleSubject {
  const narration = overrides.narration ?? "UPI/P2M/431202847592/SWIGGY*ORDER";
  const extracted = extractNarrationFields(narration);
  return {
    narration,
    importedPayee: null,
    payee: null,
    accountId: "acct-1",
    amount: rupees(-450),
    date: "2026-08-14",
    memo: null,
    tags: [],
    categoryId: null,
    cleared: false,
    source: "csv",
    cardLast4: null,
    ...extracted,
    ...overrides,
  };
}

function rule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: "r1",
    name: "Rule",
    stage: "default",
    match: "all",
    conditions: [],
    actions: [],
    enabled: true,
    ...overrides,
  };
}

describe("04 §3.6 · UPI narration extraction", () => {
  test("pulls channel, reference and merchant from a UPI string", () => {
    const f = extractNarrationFields("UPI/P2M/431202847592/SWIGGY*ORDER");
    assert.equal(f.channel, "UPI");
    assert.equal(f.reference, "431202847592");
    // MERCHANT*SUBMERCHANT collapses to MERCHANT, and ALL-CAPS is title-cased.
    assert.equal(f.merchant, "Swiggy");
  });

  test("reads a VPA and uses its local part as the merchant", () => {
    const f = extractNarrationFields("UPI/DR/400111222555/bigbasket@ybl/Payment");
    assert.equal(f.vpa, "bigbasket@ybl");
    assert.equal(f.merchant, "Bigbasket");
  });

  test("recognises other channels", () => {
    assert.equal(extractNarrationFields("NEFT-HDFC0001234-SALARY").channel, "NEFT");
    assert.equal(extractNarrationFields("ATM WDL 3150 KORAMANGALA").channel, "ATM");
    assert.equal(extractNarrationFields("POS 412374 DMART BANGALORE").channel, "POS");
  });

  test("survives narration with no structure at all", () => {
    const f = extractNarrationFields("Cash deposit");
    assert.equal(f.channel, null);
    assert.equal(f.vpa, null);
    assert.equal(f.reference, null);
  });

  test("strips a trailing order id from the merchant", () => {
    assert.equal(extractNarrationFields("POS/AMAZON 1234567890").merchant, "Amazon");
  });

  test("matching on merchant keeps working when the order id changes", () => {
    // This is the whole point of F6.9: a rule over the raw string would break
    // every single time, because the reference is different on every purchase.
    const r = rule({
      conditions: [{ field: "merchant", op: "contains", value: "swiggy" }],
      actions: [{ type: "setCategory", categoryId: "eating-out" }],
    });
    for (const n of [
      "UPI/P2M/431202847592/SWIGGY*ORDER",
      "UPI/P2M/998877665544/SWIGGY*ORDER99213",
    ]) {
      assert.equal(applyRules(subject({ narration: n, ...extractNarrationFields(n) }), [r]).subject.categoryId, "eating-out");
    }
  });
});

describe("F6 · conditions and operators", () => {
  test("supports the documented operators", () => {
    const s = subject({ amount: rupees(-1_450), memo: "weekly shop" });
    const check = (c: Parameters<typeof ruleMatches>[1]["conditions"][number]) =>
      ruleMatches(s, rule({ conditions: [c] }));

    assert.ok(check({ field: "narration", op: "contains", value: "SWIGGY" }));
    assert.ok(check({ field: "memo", op: "is", value: "weekly shop" }));
    assert.ok(check({ field: "memo", op: "startsWith", value: "weekly" }));
    assert.ok(check({ field: "absoluteAmount", op: "greaterThan", value: rupees(1_000) }));
    assert.ok(check({ field: "absoluteAmount", op: "between", value: [rupees(1_000), rupees(2_000)] }));
    assert.ok(check({ field: "direction", op: "is", value: "out" }));
    assert.ok(check({ field: "dayOfMonth", op: "is", value: 14 }));
    assert.ok(check({ field: "channel", op: "oneOf", value: ["UPI", "IMPS"] }));
    assert.ok(check({ field: "narration", op: "matches", value: "SWIGGY.*ORDER" }));
    assert.ok(!check({ field: "narration", op: "doesNotContain", value: "SWIGGY" }));
  });

  test("a malformed regex fails the condition rather than the import", () => {
    assert.equal(
      ruleMatches(subject(), rule({ conditions: [{ field: "narration", op: "matches", value: "([" }] })),
      false,
    );
  });

  test("all-of versus any-of", () => {
    const conditions = [
      { field: "channel" as const, op: "is" as const, value: "UPI" },
      { field: "merchant" as const, op: "is" as const, value: "nothing" },
    ];
    assert.equal(ruleMatches(subject(), rule({ match: "all", conditions })), false);
    assert.equal(ruleMatches(subject(), rule({ match: "any", conditions })), true);
  });

  test("matches on tags", () => {
    const s = subject({ tags: ["kerala-oct"] });
    assert.ok(ruleMatches(s, rule({ conditions: [{ field: "tags", op: "contains", value: "KERALA-OCT" }] })));
  });
});

describe("R-E1, R-E2 · stages and auto-ordering", () => {
  test("runs pre, then default, then post", () => {
    const order = orderRules([
      rule({ id: "post", stage: "post", conditions: [{ field: "narration", op: "contains", value: "a" }] }),
      rule({ id: "pre", stage: "pre", conditions: [{ field: "narration", op: "contains", value: "a" }] }),
      rule({ id: "def", stage: "default", conditions: [{ field: "narration", op: "contains", value: "a" }] }),
    ]);
    assert.deepEqual(order.map((r) => r.id), ["pre", "def", "post"]);
  });

  test("runs the broad rule before the narrow override, within a stage", () => {
    const broad = rule({
      id: "broad",
      name: "All UPI to Misc",
      conditions: [{ field: "channel", op: "is", value: "UPI" }],
      actions: [{ type: "setCategory", categoryId: "misc" }],
    });
    const narrow = rule({
      id: "narrow",
      name: "Swiggy to Eating out",
      conditions: [
        { field: "channel", op: "is", value: "UPI" },
        { field: "merchant", op: "is", value: "Swiggy" },
      ],
      actions: [{ type: "setCategory", categoryId: "eating-out" }],
    });

    assert.ok(specificity(narrow) > specificity(broad));
    // Order of the input array must not matter — users never hand-order rules.
    for (const rules of [[broad, narrow], [narrow, broad]]) {
      assert.equal(applyRules(subject(), rules).subject.categoryId, "eating-out");
    }
  });

  test("skips disabled rules", () => {
    const disabled = rule({
      enabled: false,
      conditions: [{ field: "channel", op: "is", value: "UPI" }],
      actions: [{ type: "setCategory", categoryId: "x" }],
    });
    assert.equal(applyRules(subject(), [disabled]).subject.categoryId, null);
  });
});

describe("F6.3 · actions", () => {
  test("sets payee, category, memo and tags", () => {
    const outcome = applyRules(
      subject(),
      [
        rule({
          conditions: [{ field: "merchant", op: "is", value: "Swiggy" }],
          actions: [
            { type: "setPayee", payee: "Swiggy" },
            { type: "setCategory", categoryId: "eating-out" },
            { type: "setMemo", memo: "food delivery" },
            { type: "addTag", tag: "takeaway" },
          ],
        }),
      ],
    );
    assert.equal(outcome.subject.payee, "Swiggy");
    assert.equal(outcome.subject.categoryId, "eating-out");
    assert.equal(outcome.subject.memo, "food delivery");
    assert.deepEqual(outcome.subject.tags, ["takeaway"]);
  });

  test("does not add a tag twice", () => {
    const outcome = applyRules(
      subject({ tags: ["Takeaway"] }),
      [rule({ conditions: [{ field: "channel", op: "is", value: "UPI" }], actions: [{ type: "addTag", tag: "takeaway" }] })],
    );
    assert.deepEqual(outcome.subject.tags, ["Takeaway"]);
  });

  test("splits by percentage to exact paise", () => {
    const outcome = applyRules(
      subject({ amount: rupees(-1_000) }),
      [
        rule({
          conditions: [{ field: "channel", op: "is", value: "UPI" }],
          actions: [
            {
              type: "splitPercent",
              parts: [
                { categoryId: "a", percent: 33 },
                { categoryId: "b", percent: 33 },
                { categoryId: "c", percent: 34 },
              ],
            },
          ],
        }),
      ],
    );
    const total = outcome.splits!.reduce((sum, s) => sum + s.amount, 0);
    assert.equal(total, rupees(-1_000), "a split must sum back to the transaction exactly");
  });

  test("ignore stops everything — the row is never imported", () => {
    const outcome = applyRules(
      subject(),
      [
        rule({
          id: "ignore-it",
          stage: "pre",
          conditions: [{ field: "channel", op: "is", value: "UPI" }],
          actions: [{ type: "ignore" }],
        }),
        rule({
          id: "later",
          stage: "post",
          conditions: [{ field: "channel", op: "is", value: "UPI" }],
          actions: [{ type: "setCategory", categoryId: "should-not-happen" }],
        }),
      ],
    );
    assert.equal(outcome.ignored, true);
    assert.equal(outcome.subject.categoryId, null);
  });

  test("records every rule that touched the row (R-E4, F6.8)", () => {
    const outcome = applyRules(
      subject(),
      [
        rule({ id: "a", stage: "pre", conditions: [{ field: "channel", op: "is", value: "UPI" }], actions: [{ type: "setPayee", payee: "Swiggy" }] }),
        rule({ id: "b", stage: "default", conditions: [{ field: "payee", op: "is", value: "Swiggy" }], actions: [{ type: "setCategory", categoryId: "eating-out" }] }),
      ],
    );
    assert.deepEqual(outcome.appliedRuleIds, ["a", "b"]);
    // A pre-stage rename feeding a default-stage categorisation is exactly the
    // convention R-E3 documents.
    assert.equal(outcome.subject.categoryId, "eating-out");
  });
});

describe("04 §6.5 · the auto-approve gate", () => {
  const approvable = () =>
    applyRules(subject(), [
      rule({
        conditions: [{ field: "merchant", op: "is", value: "Swiggy" }],
        actions: [
          { type: "setCategory", categoryId: "eating-out" },
          { type: "markAutoApprovable" },
        ],
      }),
    ]);

  test("lets a row through only when every condition holds", () => {
    assert.equal(mayAutoApprove(approvable(), { payeeExists: true, duplicateSuspected: false }), true);
  });

  test("holds the row back when any one fails", () => {
    assert.equal(mayAutoApprove(approvable(), { payeeExists: false, duplicateSuspected: false }), false);
    assert.equal(mayAutoApprove(approvable(), { payeeExists: true, duplicateSuspected: true }), false);
  });

  test("is off unless a rule explicitly asked for it — never global", () => {
    const outcome = applyRules(subject(), [
      rule({
        conditions: [{ field: "merchant", op: "is", value: "Swiggy" }],
        actions: [{ type: "setCategory", categoryId: "eating-out" }],
      }),
    ]);
    assert.equal(mayAutoApprove(outcome, { payeeExists: true, duplicateSuspected: false }), false);
  });

  test("a rule that marks for review overrides its own auto-approval", () => {
    const outcome = applyRules(subject(), [
      rule({
        conditions: [{ field: "merchant", op: "is", value: "Swiggy" }],
        actions: [
          { type: "setCategory", categoryId: "eating-out" },
          { type: "markAutoApprovable" },
          { type: "markForReview" },
        ],
      }),
    ]);
    assert.equal(mayAutoApprove(outcome, { payeeExists: true, duplicateSuspected: false }), false);
  });
});

describe("F6.7 · testing a rule before saving", () => {
  test("reports a match count and before/after samples", () => {
    const subjects = [
      subject({ narration: "UPI/P2M/1/SWIGGY*ORDER", merchant: "Swiggy" }),
      subject({ narration: "UPI/P2M/2/DMART", merchant: "Dmart" }),
      subject({ narration: "UPI/P2M/3/SWIGGY*ORDER", merchant: "Swiggy" }),
    ];
    const result = testRule(
      rule({
        conditions: [{ field: "merchant", op: "is", value: "Swiggy" }],
        actions: [{ type: "setCategory", categoryId: "eating-out" }],
      }),
      subjects,
    );
    assert.equal(result.matched, 2);
    assert.equal(result.samples[0]!.before.categoryId, null);
    assert.equal(result.samples[0]!.after.categoryId, "eating-out");
  });
});

// ---------------------------------------------------------------------------

describe("04 §4 · duplicate detection", () => {
  const existing = (o: Partial<Candidate> = {}): Candidate => ({
    id: "t1",
    accountId: "acct-1",
    date: "2026-08-14",
    amount: rupees(-450),
    payee: "Swiggy",
    reference: null,
    source: "csv",
    sourceId: "batch-1:row:7",
    ...o,
  });

  const incoming = (o = {}) => ({
    accountId: "acct-1",
    date: "2026-08-14",
    amount: rupees(-450),
    payee: "Swiggy",
    reference: null as string | null,
    source: "csv",
    sourceId: null as string | null,
    ...o,
  });

  test("exact — re-importing the same file creates nothing (I5)", () => {
    const match = findDuplicate(
      incoming({ sourceId: "batch-1:row:7" }),
      [existing()],
    )!;
    assert.equal(match.tier, "exact");
    assert.equal(match.action, "skip", "idempotency, not a duplicate");
  });

  test("strong — a shared bank reference auto-links rather than queueing (D4)", () => {
    const match = findDuplicate(
      incoming({ reference: "431202847592", source: "email" }),
      [existing({ reference: "431202847592", source: "csv" })],
    )!;
    assert.equal(match.tier, "strong");
    assert.equal(match.action, "upgrade");
    assert.match(match.reason, /431202847592/, "the reason names the reference");
  });

  test("probable — same amount and payee within three days, queued for a decision", () => {
    const match = findDuplicate(
      incoming({ date: "2026-08-16", source: "email" }),
      [existing({ date: "2026-08-14" })],
    )!;
    assert.equal(match.tier, "probable");
    assert.equal(match.action, "ask", "never silently dropped (N3, I4)");
    assert.match(match.reason, /2 days apart/);
  });

  test("weak — same amount and date but a different payee, lower prominence", () => {
    const match = findDuplicate(
      incoming({ payee: "Third Wave Coffee" }),
      [existing({ payee: "Swiggy" })],
    )!;
    assert.equal(match.tier, "weak");
    assert.equal(match.suggested, "keep-both", "two people, same shop, same day is normal (H5)");
  });

  test("manual-vs-imported — suggests merging, keeping the best of each (D4)", () => {
    const match = findDuplicate(
      incoming({ date: "2026-08-17", reference: "9988776655" }),
      [existing({ source: "manual", sourceId: null, date: "2026-08-14" })],
    )!;
    assert.equal(match.tier, "manual-vs-imported");
    assert.equal(match.suggested, "merge");
  });

  test("finds nothing when the amounts differ", () => {
    assert.equal(findDuplicate(incoming({ amount: rupees(-451) }), [existing()]), null);
  });

  test("never matches across accounts", () => {
    assert.equal(findDuplicate(incoming({ accountId: "acct-2" }), [existing()]), null);
  });

  test("finds nothing outside every window", () => {
    assert.equal(findDuplicate(incoming({ date: "2026-09-30" }), [existing()]), null);
  });

  test("prefers the strongest tier when several could match", () => {
    const match = findDuplicate(
      incoming({ reference: "431202847592" }),
      [
        existing({ id: "weak-one", reference: null }),
        existing({ id: "strong-one", reference: "431202847592" }),
      ],
    )!;
    assert.equal(match.tier, "strong");
    assert.equal(match.existing.id, "strong-one");
  });
});

describe("payee normalisation for comparison", () => {
  test("ignores rails, punctuation and reference numbers", () => {
    assert.equal(normalisePayee("UPI/SWIGGY*ORDER 431202847592"), normalisePayee("Swiggy"));
    assert.equal(normalisePayee("BIG BAZAAR"), normalisePayee("big-bazaar"));
  });

  test("keeps genuinely different payees apart", () => {
    assert.notEqual(normalisePayee("Swiggy"), normalisePayee("Zomato"));
  });
});

describe("merchant extraction — rails versus names", () => {
  test("strips a leading channel prefix", () => {
    assert.equal(extractNarrationFields("NEFT-ACT FIBERNET BROADBAND").merchant, "Act Fibernet Broadband");
    assert.equal(extractNarrationFields("IMPS/JOHN DOE").merchant, "John Doe");
  });

  test("keeps a hyphen that belongs to the name", () => {
    // Only a leading rail token followed by a separator is removed, so a
    // hyphenated merchant is left intact.
    assert.equal(extractNarrationFields("BIG-BAZAAR RETAIL").merchant, "Big-bazaar Retail");
  });
});
