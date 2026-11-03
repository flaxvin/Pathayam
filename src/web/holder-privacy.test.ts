/**
 * WEB-1 · FRESH-WEB-2's rule, on the other two forms that edit a holder.
 *
 * An account could not be made private to somebody other than the member
 * editing it, nor taken private out of the hands of the member whose name is
 * on it. The loan's "Whose is it / Who can see it" form and the insurance
 * policy's edit form take the same two fields and held to neither: Priya could
 * take Ravi's home loan — whose interest is his tax deduction — or his health
 * policy, set herself as holder and "Private", and both vanished from every
 * screen of his, Activity included, with nothing left for him to undo it from.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";
import type { Actor } from "../core/events.ts";
import { rupees, type Paise } from "../core/money.ts";
import { createAccount } from "../domain/accounts.ts";
import { createLoan, canSeeLoan, getLoan } from "../domain/loans.ts";
import { getAccount } from "../domain/accounts.ts";
import { createPolicy, getPolicy, canSeePolicy } from "../domain/insurance.ts";

const RAVI = "m-ravi";
const PRIYA = "m-priya";
const ravi: Actor = { memberId: RAVI, source: "ui" };

function household() {
  const db = freshDb();
  seedMember(db, RAVI, "Ravi");
  seedMember(db, PRIYA, "Priya");
  const bank = createAccount(db, ravi, {
    name: "Joint Bank", kind: "budget", subtype: "savings",
    openingDate: "2025-01-01", openingBalance: rupees(5_00_000) as Paise,
  }).id;
  const loan = createLoan(db, ravi, {
    lender: "Fictional Housing", loanType: "home", sanctioned: rupees(40_00_000) as Paise,
    sanctionDate: "2025-01-01", interestModel: "reducing", annualRatePct: 8.5, tenureMonths: 240,
    currentOutstanding: rupees(40_00_000) as Paise, repaymentAccountId: bank,
    holderMemberId: RAVI,
  });
  const policy = createPolicy(db, ravi, {
    insurer: "Fictional Health", kind: "health", premium: rupees(24_000) as Paise,
    frequency: "yearly", taxGroup: "80d-self", holderMemberId: RAVI,
  });
  return { db, loan, policy };
}

describe("WEB-1 · another member's loan or policy cannot be made private to me", () => {
  test("the loan's holder form refuses, and Ravi still sees his loan", async () => {
    const { db, loan } = household();
    const app = await startTestApp(db, { memberId: PRIYA });
    try {
      const res = await app.post(`/loans/${loan.id}/holder`, {
        holder_member_id: PRIYA, visibility: "private",
      });
      assert.equal(res.status, 422, await res.text());
      const account = getAccount(db, getLoan(db, loan.id)!.account_id)!;
      assert.equal(account.visibility, "household");
      assert.equal(account.holder_member_id, RAVI);
      assert.ok(canSeeLoan(db, loan.id, RAVI), "Ravi can no longer see his own loan");
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });

  test("nor handed, private, to somebody else — which hides it from me", async () => {
    const { db, loan } = household();
    const app = await startTestApp(db, { memberId: RAVI });
    try {
      const res = await app.post(`/loans/${loan.id}/holder`, {
        holder_member_id: PRIYA, visibility: "private",
      });
      assert.equal(res.status, 422, await res.text());
      // His own, so he may make it private to himself.
      const own = await app.post(`/loans/${loan.id}/holder`, {
        holder_member_id: RAVI, visibility: "private",
      });
      assert.equal(own.status, 303, await own.text());
      assert.equal(getAccount(db, getLoan(db, loan.id)!.account_id)!.visibility, "private");
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });

  test("the policy edit form refuses, and Ravi still sees his policy", async () => {
    const { db, policy } = household();
    const app = await startTestApp(db, { memberId: PRIYA });
    try {
      const res = await app.post(`/insurance/${policy.id}/edit`, {
        insurer: "Fictional Health", kind: "health", premium: "24000", frequency: "yearly",
        tax_group: "80d-self", holder_member_id: PRIYA, visibility: "private",
      });
      assert.equal(res.status, 422, await res.text());
      const after = getPolicy(db, policy.id)!;
      assert.equal(after.visibility, "household");
      assert.equal(after.holder_member_id, RAVI);
      assert.ok(canSeePolicy(db, policy.id, RAVI), "Ravi can no longer see his own policy");
      // An ordinary edit of the shared policy still works.
      const ok = await app.post(`/insurance/${policy.id}/edit`, {
        insurer: "Fictional Health Plus", kind: "health", premium: "24000", frequency: "yearly",
        tax_group: "80d-self", holder_member_id: RAVI, visibility: "household",
      });
      assert.equal(ok.status, 303, await ok.text());
      assert.equal(getPolicy(db, policy.id)!.insurer, "Fictional Health Plus");
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });
});
