/**
 * Pressing Enter in a form presses its first submit button. On the Move screen
 * that was the "Ready to Assign" suggestion, so a move typed out as
 * Eating out → Domestic help and sent with Enter came out of Ready to Assign
 * instead. Found in a browser: Cover an overspent envelope, pick a From, type
 * the amount, press Enter. The first submit button must now carry no source of
 * its own, so the From select decides.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp, testConfig, type TestApp } from "./harness.test-data.ts";
import { createAccount } from "../domain/accounts.ts";
import { createGroup, createCategory } from "../domain/budget.ts";
import { rupees } from "../core/money.ts";
import { todayIST } from "../core/dates.ts";

const actor = { memberId: "m-ravi", source: "ui" as const };
let app: TestApp;
let help = "";

before(async () => {
  const db = freshDb();
  seedMember(db, "m-ravi", "Ravi");
  createAccount(db, actor, {
    name: "HDFC", kind: "budget", subtype: "savings",
    openingDate: todayIST(), openingBalance: rupees(50_000),
  });
  const g = createGroup(db, actor, "Fixed");
  help = createCategory(db, actor, { groupId: g.id, name: "Domestic help" }).id;
  app = await startTestApp(db, { memberId: "m-ravi", config: testConfig({}) });
});
after(async () => { await app.close(); });

test("the Move form's default button names no source, so Enter uses the From select", async () => {
  const res = await app.get(`/move?to=${help}&amount=100`);
  const page = await res.text();
  const form = page.slice(page.indexOf('action="/move"'));
  assert.match(form, /value="rta"/, "the Ready to Assign suggestion is offered");
  const firstSubmit = form.match(/<button[^>]*type="submit"[^>]*>/)?.[0] ?? "";
  assert.ok(firstSubmit, "the form has a submit button");
  assert.doesNotMatch(firstSubmit, /\bname=/, `first submit button carries a source: ${firstSubmit}`);
});
