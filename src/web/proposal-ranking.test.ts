/**
 * N9 · The strongest handful, and the rest behind a number.
 *
 * Three years of filing produced forty-three proposals on one screen, in the
 * order they happened to be written: "You've put Blinkist in Books and courses
 * 36 times" sat below "You've put Zomato in Going out 3 times", both the same
 * size, and the eye stopped at four. Every proposal was reasonable and the list
 * was unusable.
 *
 * The count is now on the rule row rather than only inside its sentence, so the
 * list can be ordered by it. This holds both halves: the strongest lead, and
 * nothing is thrown away — the rest are one click behind their own count.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { renderProposals, type ProposedRule } from "./pages/manage.ts";
import { proposeCategoryRules } from "../import/learning.ts";
import { freshDb, seedMember } from "./harness.test-data.ts";
import { createAccount } from "../domain/accounts.ts";
import { createGroup, createCategory } from "../domain/budget.ts";
import { createTransaction } from "../domain/transactions.ts";
import { queryOne } from "../db/db.ts";
import { rupees, type Paise } from "../core/money.ts";
import type { Actor } from "../core/events.ts";

const RAVI = "m-ravi";
const ravi: Actor = { memberId: RAVI, source: "ui" };

function proposals(n: number): ProposedRule[] {
  // Deliberately weakest-first, which is the order the bug shipped in.
  return Array.from({ length: n }, (_, i) => ({
    id: `r${i}`,
    name: `Payee ${i} → Envelope ${i}`,
    because: `You've put Payee ${i} in Envelope ${i} ${i + 1} times.`,
    strength: i + 1,
  }));
}

/** What a reader sees before touching anything. */
function visible(html: string): string {
  const fold = html.indexOf("<details");
  return fold === -1 ? html : html.slice(0, fold);
}

describe("N9 · a wall of proposals is ranked and folded", () => {
  test("the strongest is first and the weakest is not on the screen", () => {
    const out = renderProposals(proposals(43)).value;
    const shown = visible(out);
    assert.ok(shown.includes("Payee 42 →"), "the strongest proposal is not shown");
    assert.ok(!shown.includes("Payee 0 →"), "the weakest proposal is still on the screen");
    assert.ok(
      shown.indexOf("Payee 42 →") < shown.indexOf("Payee 41 →"),
      "the strongest is not first",
    );
  });

  test("a handful is shown, not forty-three", () => {
    const shown = visible(renderProposals(proposals(43)).value);
    assert.equal(shown.match(/\/rules\/confirm/g)?.length, 6);
  });

  test("the rest are behind their own count, not discarded", () => {
    const out = renderProposals(proposals(43)).value;
    assert.match(out, /37 more, seen fewer times/);
    assert.equal(out.match(/\/rules\/confirm/g)?.length, 43, "a proposal was dropped");
  });

  test("a short list has nothing to fold", () => {
    const out = renderProposals(proposals(4)).value;
    assert.ok(!out.includes("<details"), "four proposals were hidden behind a disclosure");
  });

  test("a proposal records the evidence it was made from", () => {
    const db = freshDb();
    seedMember(db, RAVI, "Ravi");
    const account = createAccount(db, ravi, {
      name: "Joint current", kind: "budget", subtype: "savings",
      openingDate: "2026-01-01", openingBalance: rupees(1_00_000),
    });
    const group = createGroup(db, ravi, "Everyday");
    const category = createCategory(db, ravi, { groupId: group.id, name: "Going out" });
    for (let i = 0; i < 5; i++) {
      createTransaction(db, ravi, {
        accountId: account.id, amount: -rupees(400) as Paise,
        date: `2026-0${i + 1}-08`, categoryId: category.id,
        payeeName: "Zomato", cleared: true, ownerMemberId: RAVI,
      });
    }

    const made = proposeCategoryRules(db, ravi);
    assert.equal(made.length, 1);
    const row = queryOne<{ strength: number | null }>(
      db, `SELECT strength FROM rules WHERE id = ?`, made[0]!.id,
    );
    assert.equal(
      row?.strength, 5,
      "the count is in the sentence and nowhere a query can reach — which is why " +
      "the list could not be ordered",
    );
  });
});
