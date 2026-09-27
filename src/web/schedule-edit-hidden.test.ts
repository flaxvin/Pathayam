/**
 * IMPORTS-SCHEDULES-17 · A schedule on a hidden envelope can still be edited.
 *
 * The inline edit form offered only visible envelopes, so "Gym" −₹1,500 on
 * "Old gym", hidden since, had no option for its own envelope: the select
 * posted "", and even a rename was refused ("One of those envelope lines is
 * blank…") unless the schedule was moved somewhere else.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execute } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import type { IsoDate } from "../core/dates.ts";
import type { Paise } from "../core/money.ts";
import { createAccount } from "../domain/accounts.ts";
import { createGroup, createCategory } from "../domain/budget.ts";
import { createSchedule, getSchedule } from "../domain/schedules.ts";
import { startTestApp, seedMember, freshDb } from "./harness.test-data.ts";

/** What a browser would submit for the form, untouched. */
function formFields(html: string, action: string): Record<string, string> {
  const start = html.indexOf(`action="${action}"`);
  assert.ok(start > 0, `no form for ${action}`);
  const form = html.slice(start, html.indexOf("</form>", start));
  const out: Record<string, string> = {};
  for (const m of form.matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"/g)) out[m[1]!] = m[2]!;
  for (const m of form.matchAll(/<select[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
    const sel = /<option value="([^"]*)"\s*selected/.exec(m[2]!) ?? /<option value="([^"]*)"/.exec(m[2]!);
    out[m[1]!] = sel ? sel[1]! : "";
  }
  return out;
}

describe("IMPORTS-SCHEDULES-17 · editing a schedule filed to a hidden envelope", () => {
  test("a rename keeps the hidden envelope", async () => {
    const db = freshDb();
    seedMember(db, "m", "Ravi");
    const actor: Actor = { memberId: "m", source: "ui" };
    const acct = createAccount(db, actor, {
      name: "ZZ Savings", kind: "budget", subtype: "savings", openingDate: "2026-01-01",
    }).id;
    const g = createGroup(db, actor, "ZZ G").id;
    const gym = createCategory(db, actor, { groupId: g, name: "ZZ Old gym" }).id;
    createCategory(db, actor, { groupId: g, name: "ZZ Groceries" });
    const s = createSchedule(db, actor, {
      name: "ZZ Gym", accountId: acct, categoryId: gym, amount: -150_000 as Paise,
      recurrence: "monthly", nextDue: "2026-10-03" as IsoDate,
    }).id;
    execute(db, "UPDATE categories SET hidden_at = ? WHERE id = ?", "2026-09-01T00:00:00+05:30", gym);

    const app = await startTestApp(db, { memberId: "m" });
    try {
      const page = await (await app.get("/schedules")).text();
      assert.match(page, /ZZ Old gym \(hidden\)/);
      const fields = formFields(page, `/schedules/${s}/edit`);
      fields.name = "ZZ Gym membership";
      const res = await app.post(`/schedules/${s}/edit`, fields);
      assert.equal(res.status, 303);
      const after = getSchedule(db, s)!;
      assert.equal(after.name, "ZZ Gym membership");
      assert.equal(after.category_id, gym);
      assert.deepEqual(app.failures, []);
    } finally { await app.close(); }
  });
});
