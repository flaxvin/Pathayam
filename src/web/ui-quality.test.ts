/**
 * UIQ-5 · Three things a phone and a screen reader met in the browser sweep.
 *
 * - The logo link's only text is the wordmark, which a narrow screen hides —
 *   so on a phone it was a link with no name ("link", and nothing else).
 * - The tax page's two regime cards were h3s straight under the h1.
 * - An uncleared register row was dimmed with `opacity: .75`, which takes
 *   every colour in the row with it: the "Uncategorised" chip fell to 3.3:1.
 *   The Cleared column already says which rows are uncleared in words.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execute } from "../db/db.ts";
import { nowIST } from "../core/dates.ts";
import { freshHousehold, RAVI } from "../engine/identity.test-data.ts";
import { startTestApp, type TestApp } from "./harness.test-data.ts";
import { page } from "./layout.ts";
import { raw } from "../http/html.ts";
import { STYLESHEET } from "./styles.ts";
import { readFileSync } from "node:fs";

describe("UIQ-5 · names, headings and contrast", () => {
  test("the logo link has a name of its own", () => {
    const html = page({ title: "Budget", theme: "system", memberName: "Ravi" }, raw("<p>x</p>"));
    assert.match(html, /<a class="brand" href="\/" aria-label="[^"]+"/);
  });

  test("an uncleared register row is not dimmed with opacity", () => {
    const source = readFileSync(new URL("./pages/accounts.ts", import.meta.url), "utf8");
    assert.doesNotMatch(source, /opacity:\s*\.75/);
    assert.match(STYLESHEET, /\.row-uncleared/);
  });

  describe("the tax page never skips a heading level", () => {
    let app: TestApp;
    before(async () => {
      const db = freshHousehold();
      execute(db, `UPDATE household SET setup_completed_at = ? WHERE id = 1`, nowIST());
      app = await startTestApp(db, { memberId: RAVI });
    });
    after(() => app.close());

    test("with an estimate showing", async () => {
      const form = await (await app.get("/tax")).text();
      const fy = /name="fy" value="([^"]+)"/.exec(form)![1]!;
      const saved = await app.post("/tax", { fy, gross: "1800000" });
      assert.ok(saved.status < 400, `posting the figures answered ${saved.status}`);
      const body = await (await app.get(`/tax?fy=${fy}`)).text();
      assert.match(body, /New regime/);
      const levels = [...body.matchAll(/<h([1-6])[\s>]/g)].map((m) => Number(m[1]));
      for (let i = 1; i < levels.length; i++) {
        assert.ok(levels[i]! <= levels[i - 1]! + 1, `h${levels[i - 1]} then h${levels[i]}`);
      }
    });
  });
});
