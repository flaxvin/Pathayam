/**
 * A write has to come from this app's own pages.
 *
 * The session cookie is `SameSite=Lax`, which a browser honours by not sending
 * it on a cross-site POST, and no GET in this router changes anything — a
 * separate test walks every handler to keep that true. So CSRF was covered.
 *
 * It was covered by **one property of one cookie attribute**. The day somebody
 * adds a state-changing GET, or a browser is configured oddly, it stops being
 * covered and nothing says so. This is the second lock, and unlike a hidden
 * token in each of a hundred and five forms it cannot be left off the hundred
 * and sixth.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp, type TestApp } from "./harness.test-data.ts";
import { createAccount } from "../domain/accounts.ts";
import { createGroup, createCategory } from "../domain/budget.ts";
import { queryOne } from "../db/db.ts";
import { rupees, type Paise } from "../core/money.ts";
import { todayIST, monthOf } from "../core/dates.ts";
import type { Actor } from "../core/events.ts";

const RAVI = "m-ravi";
const ravi: Actor = { memberId: RAVI, source: "ui" };
const MONTH = monthOf(todayIST());

let app: TestApp;
let category: string;

before(async () => {
  const db = freshDb();
  seedMember(db, RAVI, "Ravi");
  createAccount(db, ravi, {
    name: "Joint current", kind: "budget", subtype: "savings",
    openingDate: "2026-01-01", openingBalance: rupees(5_00_000) as Paise,
  });
  const group = createGroup(db, ravi, "Everyday");
  category = createCategory(db, ravi, { groupId: group.id, name: "Groceries" }).id;
  app = await startTestApp(db, { memberId: RAVI });
});

after(async () => {
  await app.close();
});

function assigned(): number {
  return queryOne<{ amount: number }>(
    app.db, `SELECT amount FROM assignments WHERE month = ? AND category_id = ?`, MONTH, category,
  )?.amount ?? 0;
}

const assign = (headers: Record<string, string>) =>
  app.post("/assign", { month: MONTH, category_id: category, amount: "1000" }, { headers });

describe("a write has to come from this app", () => {
  test("a post from another site is refused, and changes nothing", async () => {
    const before = assigned();
    const res = await assign({ Origin: "https://evil.example" });
    assert.equal(res.status, 403);
    assert.equal(assigned(), before, "the refused write still happened");
  });

  test("a post with no Origin and no Referer is refused", async () => {
    // Not a browser. A browser sends one or the other on a same-origin form
    // post, so nothing legitimate is turned away by this.
    const before = assigned();
    const res = await app.post(
      "/assign",
      { month: MONTH, category_id: category, amount: "1000" },
      { headers: { Origin: "" } },
    );
    assert.equal(res.status, 403);
    assert.equal(assigned(), before);
  });

  test("a Referer from this app is enough, for the browsers that send no Origin", async () => {
    const res = await app.post(
      "/assign",
      { month: MONTH, category_id: category, amount: "2500" },
      { headers: { Origin: "", Referer: `${app.baseUrl}/` } },
    );
    assert.equal(res.status, 303);
    assert.equal(assigned(), rupees(2_500));
  });

  test("and a Referer from somewhere else is not", async () => {
    const before = assigned();
    const res = await app.post(
      "/assign",
      { month: MONTH, category_id: category, amount: "9999" },
      { headers: { Origin: "", Referer: "https://evil.example/page" } },
    );
    assert.equal(res.status, 403);
    assert.equal(assigned(), before);
  });

  test("reading is untouched", async () => {
    // Only unsafe methods are checked: a GET that changes nothing is nobody's
    // business where it came from, and links from elsewhere have to work.
    const res = await app.get("/", { headers: { Referer: "https://example.com/" } });
    assert.equal(res.status, 200);
  });
});
