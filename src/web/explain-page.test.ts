/**
 * UIQ-1 · "How is this worked out?" opened on its own is a page, not markup.
 *
 * The explain links open a dialog: the client fetches the URL and drops the
 * answer in. But they are ordinary links, and a phone's long-press "Open in new
 * tab", a middle click, or a script that failed to load all navigate to them
 * instead. The answer was a fragment beginning with a newline, which the
 * response writer does not recognise as HTML, so it went out as text/plain and
 * the browser printed the raw tags — `<h2>Ready to Assign</h2>` on screen.
 *
 * A navigation now gets the explanation inside the app's own page, with its one
 * h1; the dialog's fetch still gets the bare fragment. And a line with no date
 * or author no longer prints a lone " · " under it.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execute } from "../db/db.ts";
import { nowIST, todayIST, monthOf } from "../core/dates.ts";
import { freshHousehold, RAVI } from "../engine/identity.test-data.ts";
import { createGroup, createCategory } from "../domain/budget.ts";
import { startTestApp, type TestApp } from "./harness.test-data.ts";
import type { Actor } from "../core/events.ts";

const ravi: Actor = { memberId: RAVI, source: "ui" };
const NOW = monthOf(todayIST());

describe("UIQ-1 · explain pages", () => {
  let app: TestApp;
  let categoryId: string;
  before(async () => {
    const db = freshHousehold();
    const group = createGroup(db, ravi, "Living");
    categoryId = createCategory(db, ravi, { groupId: group.id, name: "Groceries" }).id;
    execute(db, `UPDATE household SET setup_completed_at = ? WHERE id = 1`, nowIST());
    app = await startTestApp(db, { memberId: RAVI });
  });
  after(() => app.close());

  const paths = () => [
    `/explain/ready-to-assign?month=${NOW}`,
    `/explain/category/${categoryId}?month=${NOW}`,
  ];

  test("navigated to directly, it is an HTML page with the app around it", async () => {
    for (const path of paths()) {
      const res = await app.get(path, { headers: { "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" } });
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get("content-type") ?? "", /^text\/html/, path);
      const body = await res.text();
      assert.match(body, /^<!doctype html>/i, `${path} is a whole page`);
      assert.match(body, /<meta name="viewport"/, `${path} fits a phone`);
      assert.equal((body.match(/<h1[\s>]/g) ?? []).length, 1, `${path} has one h1`);
    }
  });

  test("fetched by the dialog, it is still the bare fragment", async () => {
    for (const path of paths()) {
      const res = await app.get(path, { headers: { "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty", "X-Fragment": "1" } });
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get("content-type") ?? "", /^text\/html/, path);
      const body = await res.text();
      assert.doesNotMatch(body, /<!doctype/i, `${path} is a fragment`);
      assert.match(body, /<h2>/, path);
    }
  });

  test("a line with no date and no author carries no stray separator", async () => {
    const body = await (await app.get(paths()[0]!, { headers: { "X-Fragment": "1" } })).text();
    assert.doesNotMatch(body, /class="explain-when">\s*·\s*</);
  });
});
