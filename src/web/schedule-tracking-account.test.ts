/**
 * IMPORTS-SCHEDULES-16 · A schedule on a tracking account.
 *
 * A tracking account belongs to no budget and money into it names no
 * envelope, so a "PPF deposit" schedule matched neither end of /schedules'
 * scope in any scope: "Schedule added.", then never listed — no Paid, Skip,
 * Edit or Remove anywhere. And the inline edit form offered only budget and
 * credit accounts, so saving it unchanged would have cleared its account.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Actor } from "../core/events.ts";
import { createAccount } from "../domain/accounts.ts";
import { getSchedule, listSchedules } from "../domain/schedules.ts";
import { startTestApp, seedMember, freshDb } from "./harness.test-data.ts";

/** Read the inline edit form and submit it as a browser would. */
function formFields(html: string, action: string): Record<string, string> {
  const start = html.indexOf(`action="${action}"`);
  const form = html.slice(start, html.indexOf("</form>", start));
  const out: Record<string, string> = {};
  for (const m of form.matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"/g)) out[m[1]!] = m[2]!;
  for (const m of form.matchAll(/<select[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
    const sel = /<option value="([^"]*)"\s*selected/.exec(m[2]!) ?? /<option value="([^"]*)"/.exec(m[2]!);
    out[m[1]!] = sel ? sel[1]! : "";
  }
  return out;
}

test("a schedule into a tracking account is listed, and editing it keeps the account", async () => {
  const db = freshDb();
  seedMember(db, "m-ravi", "Ravi");
  const actor: Actor = { memberId: "m-ravi", source: "ui" };
  createAccount(db, actor, { name: "ZZ Savings", kind: "budget", subtype: "savings", openingDate: "2026-01-01" });
  const ppf = createAccount(db, actor, { name: "ZZ PPF", kind: "tracking", subtype: "asset", openingDate: "2026-01-01" }).id;
  const app = await startTestApp(db, { memberId: "m-ravi" });
  try {
    const r = await app.post("/schedules/new", { name: "ZZ PPF deposit", amount: "5000", direction: "in",
      recurrence: "monthly", next_due: "2026-10-05", account_id: ppf });
    assert.equal(r.status, 303);
    const id = listSchedules(db)[0]!.id;

    const page = await (await app.get("/schedules")).text();
    assert.ok(page.includes(`/schedules/${id}/edit`), "the schedule is not on /schedules");
    assert.ok((await (await app.get("/schedules?scope=all")).text()).includes(`/schedules/${id}/edit`));

    const fields = formFields(page, `/schedules/${id}/edit`);
    fields.name = "ZZ PPF monthly deposit";
    assert.equal((await app.post(`/schedules/${id}/edit`, fields)).status, 303);
    assert.equal(getSchedule(db, id)!.name, "ZZ PPF monthly deposit");
    assert.equal(getSchedule(db, id)!.account_id, ppf);
    assert.deepEqual(app.failures, []);
  } finally {
    await app.close();
  }
});
