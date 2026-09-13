/**
 * H2.2 / H2.3 · Private tracking accounts, and whose figures are whose.
 *
 * The rule that shapes all of this is arithmetic rather than policy: Ready to
 * Assign is a sum over every Budget account, so hiding one while showing the
 * total publishes it by subtraction. So a thing can be private only when no
 * shared total is built on it: a Tracking account, which funds nothing, or an
 * account in a personal budget, whose Ready to Assign is its owner's alone.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, type DB } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST, todayIST } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import { createAccount, updateAccount, listAccounts, hiddenAccountIds, getAccount } from "./accounts.ts";
import { createAssetAccount, recordValuation, listAssetAccounts } from "./assets.ts";
import { createLoan } from "./loans.ts";
import { createFamilyLoan } from "./family-loans.ts";
import { netWorthStatement } from "./networth.ts";
import { readFileSync } from "node:fs";
import { ensurePersonalBudget, householdBudgetId } from "./budgets.ts";

const RAVI = "m-ravi";
const PRIYA = "m-priya";
const actor: Actor = { memberId: RAVI, source: "ui" };

function setup(): DB {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  for (const [id, name] of [[RAVI, "Ravi"], [PRIYA, "Priya"]] as const) {
    execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
      id, `${name.toLowerCase()}@example.com`, name, nowIST());
  }
  return db;
}

describe("H2.2 · only what funds nothing may be private", () => {
  test("H2.2a · a budget or credit account in the HOUSEHOLD budget cannot be private", () => {
    const db = setup();
    for (const kind of ["budget", "credit"] as const) {
      assert.throws(
        () => createAccount(db, actor, {
          name: "X", kind, subtype: kind === "budget" ? "savings" : "credit-card",
          visibility: "private", holderMemberId: RAVI,
        }),
        /would not hide the amount/,
        `the household's Ready to Assign sums a ${kind} account, so hiding one is a false promise`,
      );
    }
    const bank = createAccount(db, actor, {
      name: "HDFC", kind: "budget", subtype: "savings", holderMemberId: RAVI,
    });
    assert.throws(() => updateAccount(db, actor, bank.id, { visibility: "private" }),
      /would not hide the amount/);
    db.close();
  });

  test("H2.2a · the same account may be private once it is in a personal budget", () => {
    /*
     * The rule did not weaken; what made it leak went away. A personal budget's
     * accounts are never summed into the household's Ready to Assign — only the
     * amount their owner commits is (15 §3.3) — so there is nothing to infer.
     */
    const db = setup();
    const mine = ensurePersonalBudget(db, RAVI, "Ravi");

    const card = createAccount(db, actor, {
      name: "My card", kind: "credit", subtype: "credit-card",
      holderMemberId: RAVI, visibility: "private", budgetId: mine.id,
    });
    assert.equal(getAccount(db, card.id)!.visibility, "private");

    // And moving it back into the household budget while private is refused,
    // rather than silently re-exposing it.
    assert.throws(
      () => updateAccount(db, actor, card.id, { budget_id: householdBudgetId(db) }),
      /would not hide the amount/,
    );
    db.close();
  });

  test("every kind of tracking account can be private", () => {
    // Assets, loans, family lending and plain tracking all land in `accounts`
    // with kind='tracking', so one rule has to cover all four creators.
    const db = setup();
    const gold = createAssetAccount(db, actor, {
      name: "Gold", subtype: "commodity", holderMemberId: PRIYA, visibility: "private",
    });
    const loan = createLoan(db, actor, {
      lender: "Axis", loanType: "personal", interestModel: "flat", annualRatePct: 11,
      sanctioned: rupees(1_00_000), sanctionDate: todayIST(), tenureMonths: 12,
      firstInstalmentDate: todayIST(), holderMemberId: PRIYA, visibility: "private",
    });
    const lent = createFamilyLoan(db, actor, {
      counterparty: "A friend", holderMemberId: PRIYA, visibility: "private",
    });
    const fd = createAccount(db, actor, {
      name: "SBI FD", kind: "tracking", subtype: "fixed-deposit",
      holderMemberId: PRIYA, visibility: "private",
    });

    const hiddenFromRavi = hiddenAccountIds(db, RAVI);
    for (const id of [gold.id, loan.accountId ?? "", fd.id]) {
      if (id) assert.ok(hiddenFromRavi.has(id), "should be hidden from the other member");
    }
    assert.equal(hiddenAccountIds(db, PRIYA).size, 0, "the holder sees their own");
    void lent;
    db.close();
  });
});

describe("H2.2 · what a viewer is shown", () => {
  test("a private account is absent from the other member's lists", () => {
    const db = setup();
    createAccount(db, actor, {
      name: "Priya's FD", kind: "tracking", subtype: "fixed-deposit",
      holderMemberId: PRIYA, visibility: "private",
    });
    createAccount(db, actor, { name: "Joint FD", kind: "tracking", subtype: "fixed-deposit" });

    const ravi = listAccounts(db, { viewerMemberId: RAVI }).map((a) => a.name);
    const priya = listAccounts(db, { viewerMemberId: PRIYA }).map((a) => a.name);
    const unfiltered = listAccounts(db).map((a) => a.name);

    assert.deepEqual(ravi, ["Joint FD"]);
    assert.deepEqual(priya.sort(), ["Joint FD", "Priya's FD"]);
    assert.equal(unfiltered.length, 2, "an omitted viewer still sees everything, for export and backup");
    db.close();
  });

  test("assets are filtered the same way", () => {
    const db = setup();
    createAssetAccount(db, actor, {
      name: "Priya's gold", subtype: "commodity", holderMemberId: PRIYA, visibility: "private",
    });
    createAssetAccount(db, actor, { name: "Joint property", subtype: "physical" });
    assert.deepEqual(
      listAssetAccounts(db, { viewerMemberId: RAVI }).map((a) => a.name),
      ["Joint property"],
    );
    db.close();
  });
});

describe("H2.3 · whose net worth", () => {
  function withAssets(db: DB) {
    const mine = createAssetAccount(db, actor, {
      name: "Ravi's gold", subtype: "commodity", holderMemberId: RAVI,
    });
    const hers = createAssetAccount(db, actor, {
      name: "Priya's gold", subtype: "commodity", holderMemberId: PRIYA, visibility: "private",
    });
    const joint = createAssetAccount(db, actor, { name: "Flat", subtype: "physical" });
    recordValuation(db, actor, { accountId: mine.id, value: rupees(1_00_000), asOf: todayIST() });
    recordValuation(db, actor, { accountId: hers.id, value: rupees(2_00_000), asOf: todayIST() });
    recordValuation(db, actor, { accountId: joint.id, value: rupees(50_00_000), asOf: todayIST() });
  }

  test("a private asset is left out of the other member's total, not just their list", () => {
    // The whole point. A line hidden but still summed is published by
    // subtraction to anyone who can see every other line.
    const db = setup();
    withAssets(db);
    const ravi = netWorthStatement(db, todayIST(), "INR", { viewerMemberId: RAVI });
    assert.equal(ravi.netWorth, rupees(51_00_000), "Priya's ₹2,00,000 must not be in Ravi's total");

    const priya = netWorthStatement(db, todayIST(), "INR", { viewerMemberId: PRIYA });
    assert.equal(priya.netWorth, rupees(53_00_000), "her own private asset counts for her");
    db.close();
  });

  test("scopes split the figure into mine, joint and everything visible", () => {
    const db = setup();
    withAssets(db);
    const of = (scope: "household" | "mine" | "joint") =>
      netWorthStatement(db, todayIST(), "INR", { viewerMemberId: RAVI, scope }).netWorth;

    assert.equal(of("mine"), rupees(1_00_000));
    assert.equal(of("joint"), rupees(50_00_000));
    assert.equal(of("household"), rupees(51_00_000), "mine + joint, and nobody else's private");
    db.close();
  });

  test("with no viewer supplied nothing is filtered, which is what a snapshot needs", () => {
    const db = setup();
    withAssets(db);
    assert.equal(netWorthStatement(db).netWorth, rupees(53_00_000));
    db.close();
  });
});

describe("H2.2 · view as must not become a way around it", () => {
  test("the viewer is the authenticated member, never the one being viewed as", () => {
    /*
     * This is the whole point of the feature and it is one word wide: reading
     * `viewingAs` here would mean impersonating somebody shows you exactly what
     * they marked private. Verified live as well, but pinned here because the
     * mistake is a plausible tidy-up by someone who sees two member ids and
     * picks the one the page is "about".
     */
    const app = readFileSync(new URL("../app.ts", import.meta.url), "utf8");
    const helper = app.slice(app.indexOf("function viewer(ctx: RequestContext)"));
    const body = helper.slice(0, helper.indexOf("\n  }") + 4);

    assert.match(body, /a\?\.member\.id/, "must read the authenticated member");
    assert.doesNotMatch(body, /viewingAs/, "must not read the impersonated member");
  });
});

describe("H2.2a · private in a personal budget", () => {
  test("a private account can be created straight into a personal budget", () => {
    const db = setup();
    const budget = ensurePersonalBudget(db, PRIYA, "Priya");

    const account = createAccount(db, actor, {
      name: "Priya's savings",
      kind: "budget",
      subtype: "savings",
      holderMemberId: PRIYA,
      visibility: "private", holderMemberId: PRIYA,
      budgetId: budget.id,
      openingBalance: rupees(5_000),
    });

    assert.equal(account.visibility, "private");
    assert.equal(account.budget_id, budget.id);
    // It funds her budget, not the household's — which is the whole reason it
    // is allowed to be private at all.
    assert.equal(
      listAccounts(db, { viewerMemberId: PRIYA }).some((a) => a.id === account.id),
      true,
    );
  });

  test("moving an already-private account back to the household is refused in words", () => {
    const db = setup();
    const budget = ensurePersonalBudget(db, PRIYA, "Priya");
    const account = createAccount(db, actor, {
      name: "Priya's savings",
      kind: "budget",
      subtype: "savings",
      holderMemberId: PRIYA,
      visibility: "private", holderMemberId: PRIYA,
      budgetId: budget.id,
    });

    // The raw CHECK would catch this too, but with a sentence about a
    // constraint rather than about money.
    assert.throws(
      () => updateAccount(db, actor, account.id, { budget_id: householdBudgetId(db) }),
      /would not hide the amount/,
    );
  });
});

describe("B107 · an unmentioned field is not a field set to null", () => {
  test("passing undefined leaves the column alone", () => {
    const db = setup();
    const account = createAccount(db, actor, {
      name: "Joint current", kind: "budget", subtype: "savings",
      holderMemberId: RAVI, openingBalance: rupees(10_000),
    });

    // A form that offers `visibility` only when there are two budgets sends
    // nothing for it, and the route turns that into an explicit undefined.
    const after = updateAccount(db, actor, account.id, {
      name: "Joint current",
      visibility: undefined,
      holder_member_id: undefined,
    });

    assert.equal(after.visibility, "household", "NOT NULL would have thrown, or NULL would have stuck");
    assert.equal(after.holder_member_id, RAVI, "and an omitted field keeps its value");
  });

  test("passing null still clears a nullable column", () => {
    const db = setup();
    const account = createAccount(db, actor, {
      name: "Joint current", kind: "budget", subtype: "savings", holderMemberId: RAVI,
    });
    assert.equal(updateAccount(db, actor, account.id, { holder_member_id: null }).holder_member_id, null);
    db.close();
  });
});

describe("H2.2 · private means private to somebody", () => {
  /**
   * Asked what happens if a *household* thing — one with no holder — is marked
   * private, the answer was: it disappears for everyone, including the person who
   * set it, which makes it unfixable through the app because undoing it would
   * require seeing it. The two controls sit side by side on the form and neither
   * mentioned the other.
   */
  test("private with nobody holding it is refused, in words", () => {
    const db = setup();
    assert.throws(
      () => createAccount(db, actor, {
        name: "Orphan", kind: "tracking", subtype: "asset",
        visibility: "private",
      }),
      /Private to whom/,
    );
  });

  test("and refused on edit, from either direction", () => {
    const db = setup();
    const account = createAccount(db, actor, {
      name: "Gold", kind: "tracking", subtype: "asset",
      holderMemberId: RAVI, visibility: "private",
    });

    // Taking the holder away from something private.
    assert.throws(
      () => updateAccount(db, actor, account.id, { holder_member_id: null }),
      /Private to whom/,
    );
    // And making something holderless private.
    const joint = createAccount(db, actor, {
      name: "Joint gold", kind: "tracking", subtype: "asset",
    });
    assert.throws(
      () => updateAccount(db, actor, joint.id, { visibility: "private" }),
      /Private to whom/,
    );
  });

  test("with a holder, it is visible to them and nobody else", () => {
    const db = setup();
    const account = createAccount(db, actor, {
      name: "Ravi's gold", kind: "tracking", subtype: "asset",
      holderMemberId: RAVI, visibility: "private",
    });
    const visible = (viewer: string | null) =>
      listAccounts(db, { viewerMemberId: viewer }).some((a) => a.id === account.id);

    assert.equal(visible(RAVI), true, "its holder");
    assert.equal(visible(PRIYA), false, "and nobody else");
  });
});
