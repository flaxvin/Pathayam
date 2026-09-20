/**
 * A form has to contain its own fields.
 *
 * One stray `</div>` — left behind when the category field it used to close
 * was replaced by the envelope lines — ended the `<form>` on the add screen
 * early. Everything after the envelope (account, date, who spent it, Save) was
 * parsed as a sibling of the form rather than a child, and of `<main>` too, so
 * the card ended mid-page and the rest of the fields sat outside it. That is
 * what a household would have seen: the screen they use every day, visibly
 * broken below the envelope.
 *
 * It kept *working*, which is why nothing caught it. The HTML parser sets a
 * field's form owner when it is parsed, so those inputs still submitted with
 * the form despite not being inside it — every route test passed, and the
 * damage was entirely in the rendering.
 *
 * These count opening and closing tags in the rendered page. Crude next to a
 * real parser, and a real parser is not available here — the project ships no
 * runtime dependency — but an unbalanced `<div>` is exactly the shape of the
 * fault, and a count catches it wherever it happens.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp, testConfig, type TestApp } from "./harness.test-data.ts";
import { createAccount } from "../domain/accounts.ts";
import { createGroup, createCategory } from "../domain/budget.ts";
import { createSchedule } from "../domain/schedules.ts";
import { createTransaction } from "../domain/transactions.ts";
import { rupees, type Paise } from "../core/money.ts";

const actor = { memberId: "m-ravi", source: "ui" as const };
let app: TestApp;
let txId: string;

before(async () => {
  const db = freshDb();
  seedMember(db, "m-ravi", "Ravi");
  const bank = createAccount(db, actor, {
    name: "HDFC", kind: "budget", subtype: "savings",
    openingDate: "2026-08-01", openingBalance: rupees(100_000),
  }).id;
  const g = createGroup(db, actor, "Home");
  const rent = createCategory(db, actor, { groupId: g.id, name: "Rent" }).id;
  const upkeep = createCategory(db, actor, { groupId: g.id, name: "Upkeep" }).id;

  createSchedule(db, actor, {
    name: "Flat", accountId: bank, categoryId: rent,
    amount: -rupees(32_000) as Paise, recurrence: "monthly", nextDue: "2026-10-05",
  });
  txId = createTransaction(db, actor, {
    accountId: bank, amount: -rupees(3_000) as Paise, date: "2026-09-06",
    splits: [
      { categoryId: rent, amount: -rupees(2_000) as Paise },
      { categoryId: upkeep, amount: -rupees(1_000) as Paise },
    ],
  }).id;

  app = await startTestApp(db, { memberId: "m-ravi", config: testConfig({}) });
});

after(async () => { await app.close(); });

/** Opening tags of `name`, ignoring self-closing and closing ones. */
function countTags(html: string, name: string): { open: number; close: number } {
  const open = html.match(new RegExp(`<${name}(?=[\\s>])`, "g"))?.length ?? 0;
  const close = html.match(new RegExp(`</${name}>`, "g"))?.length ?? 0;
  return { open, close };
}

const SCREENS = [
  ["/add", "add a transaction"],
  ["/schedules/new", "add a schedule"],
  ["/schedules", "the schedule list, which carries an edit form per schedule"],
] as const;

describe("every screen that files money closes what it opens", () => {
  for (const [path, what] of SCREENS) {
    test(`${path} — ${what}`, async () => {
      const body = await (await app.get(path)).text();
      for (const tag of ["div", "form", "details", "fieldset"]) {
        const { open, close } = countTags(body, tag);
        assert.equal(
          open, close,
          `<${tag}> is opened ${open} times and closed ${close} on ${path} — ` +
          "an unbalanced one silently moves everything after it out of its parent",
        );
      }
    });
  }

  test("/transaction/:id — edit a transaction", async () => {
    const body = await (await app.get(`/transaction/${txId}`)).text();
    for (const tag of ["div", "form", "details", "fieldset"]) {
      const { open, close } = countTags(body, tag);
      assert.equal(open, close, `<${tag}> is unbalanced on the transaction edit screen`);
    }
  });
});

describe("the Save button is inside the form it submits", () => {
  /*
   * The specific consequence worth naming: with the form closed early, Save sat
   * outside it. It still submitted — the parser had already given it its form
   * owner — so this could only ever have been caught by looking at where the
   * markup actually puts it.
   */
  for (const [path] of SCREENS) {
    test(path, async () => {
      const body = await (await app.get(path)).text();
      const formStart = body.indexOf("<form method=\"post\"");
      assert.ok(formStart > -1, "no form on the page at all");

      // Walk from the first form open tag to its matching close, counting
      // nested forms (there are none in HTML, but the count keeps this honest).
      const after = body.slice(formStart);
      const end = after.indexOf("</form>");
      assert.ok(end > -1, "the form is never closed");
      const inside = after.slice(0, end);

      assert.match(
        inside, /<button[^>]*type="submit"/,
        "the first form on the page closes before its own submit button",
      );
    });
  }
});
