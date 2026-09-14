/**
 * Every route that addresses one thing, addressed at somebody else's thing.
 *
 * `privacy-sweep.test.ts` renders every screen as the wrong member and looks for
 * a planted string — but it skips parameterised routes, because they need an id.
 * `viewer-required.test.ts` checks that anything *able* to take a viewer is
 * given one — but a function that never took one is invisible to it.
 *
 * Between those two sits the gap this closes: `/attachment/:id` served the
 * actual bytes of a receipt on another member's private account, to any signed-in
 * member who had the id, and let them delete it. Not a name or a number — the
 * document. Neither guard could have seen it: the sweep skips the route, and
 * `getBytes(db, id)` has no viewer to be missing.
 *
 * So: build one member's private everything, then aim every parameterised route
 * in the router at it as somebody else, and require not-found. Not "no details" —
 * **not-found**, because confirming that a thing exists is itself the disclosure.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { freshDb, seedMember, startTestApp, type TestApp } from "./harness.test-data.ts";
import { createAccount } from "../domain/accounts.ts";
import { createGroup, createCategory } from "../domain/budget.ts";
import { createTransaction } from "../domain/transactions.ts";
import { addAttachment } from "../domain/attachments.ts";
import { createLoan } from "../domain/loans.ts";
import { createFamilyLoan } from "../domain/family-loans.ts";
import { ensurePersonalBudget } from "../domain/budgets.ts";
import { rupees, type Paise } from "../core/money.ts";
import { todayIST } from "../core/dates.ts";
import type { Actor } from "../core/events.ts";

const RAVI = "m-ravi";
const PRIYA = "m-priya";
const ravi: Actor = { memberId: RAVI, source: "ui" };

/** A one-pixel PNG, so the receipt is a real file with real bytes. */
const RECEIPT = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let priya: TestApp;
let ids: Record<string, string>;

before(async () => {
  const db = freshDb();
  seedMember(db, RAVI, "Ravi");
  seedMember(db, PRIYA, "Priya");

  const his = ensurePersonalBudget(db, RAVI, "Ravi");
  const account = createAccount(db, ravi, {
    name: "Zzyzx Private Account", kind: "budget", subtype: "savings",
    openingDate: "2026-01-01", openingBalance: rupees(3_00_000) as Paise,
    holderMemberId: RAVI, visibility: "private", budgetId: his.id,
  });
  const group = createGroup(db, ravi, "Mine", "normal", his.id);
  const category = createCategory(db, ravi, { groupId: group.id, name: "Qwertyuiop Envelope" });
  const transaction = createTransaction(db, ravi, {
    accountId: account.id, amount: -rupees(4_321) as Paise, date: todayIST(),
    categoryId: category.id, payeeName: "Vantablack Merchant", cleared: true, ownerMemberId: RAVI,
  });
  const attachment = addAttachment(db, ravi, {
    transactionId: transaction.id, filename: "Pennyfarthing receipt.png",
    mime: "image/png", bytes: new Uint8Array(RECEIPT),
  });
  const loan = createLoan(db, ravi, {
    lender: "Xylophone Finance", loanType: "personal", sanctioned: rupees(1_00_000),
    sanctionDate: "2026-01-01", interestModel: "reducing", annualRatePct: 13,
    tenureMonths: 24, currentOutstanding: rupees(1_00_000),
    repaymentAccountId: account.id, holderMemberId: RAVI, visibility: "private",
  });
  const family = createFamilyLoan(db, ravi, {
    counterparty: "Pennyfarthing Cousin", holderMemberId: RAVI, visibility: "private",
  });

  ids = {
    account: account.id, category: category.id, transaction: transaction.id,
    attachment: attachment.id, loan: loan.id, family: family.id, group: group.id,
  };
  priya = await startTestApp(db, { memberId: PRIYA });
});

after(async () => {
  await priya.close();
});

/** Which of Ravi's private things each route pattern addresses. */
function target(path: string): string | null {
  if (path.startsWith("/attachment/")) return ids.attachment!;
  if (path.startsWith("/accounts/")) return ids.account!;
  if (path.startsWith("/transaction/")) return ids.transaction!;
  if (path.startsWith("/explain/category/") || path.startsWith("/categories/")) return ids.category!;
  if (path.startsWith("/groups/")) return ids.group!;
  if (path.startsWith("/loans/")) return ids.loan!;
  if (path.startsWith("/family/")) return ids.family!;
  return null;
}

/** Every parameterised route the router serves, from the router itself. */
function parameterisedRoutes(): { method: "get" | "post"; path: string }[] {
  const app = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "app.ts"), "utf8",
  );
  return [...app.matchAll(/router\.(get|post)\(\s*"([^"]*:[^"]+)"/g)]
    .map((m) => ({ method: m[1] as "get" | "post", path: m[2]! }))
    .filter((r) => target(r.path) !== null)
    // A second parameter the sweep has no value for would 404 on that instead,
    // proving nothing.
    .filter((r) => (r.path.match(/:/g) ?? []).length === 1);
}

describe("H2.2 · one member's things, addressed by another member", () => {
  const routes = parameterisedRoutes();

  test("there are routes to check", () => {
    assert.ok(routes.length > 20, `only ${routes.length} routes matched`);
  });

  test("every one answers not-found", async () => {
    const leaked: string[] = [];
    for (const route of routes) {
      const path = route.path.replace(/:[A-Za-z]+/, target(route.path)!);
      const res = route.method === "get" ? await priya.get(path) : await priya.post(path, {});
      // 404 is the answer. A 400 is acceptable where the route needs a body it
      // did not get — it means the handler refused before doing anything — but
      // a 200 or a redirect means it acted on somebody else's thing.
      if (res.status !== 404 && res.status !== 400) {
        leaked.push(`${route.method.toUpperCase()} ${path} → ${res.status}`);
      }
    }
    assert.deepEqual(
      leaked, [],
      "these acted on another member's private thing instead of answering not-found",
    );
  });

  test("and the receipt's bytes are not served", async () => {
    // Called out separately because it is the worst of them: not a name or a
    // figure but the document itself, byte for byte.
    const res = await priya.get(`/attachment/${ids.attachment}`);
    assert.equal(res.status, 404);
    const body = Buffer.from(await res.arrayBuffer());
    assert.ok(!body.equals(RECEIPT), "the private receipt was served in full");
  });
});
