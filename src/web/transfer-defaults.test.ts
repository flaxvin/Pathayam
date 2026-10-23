/**
 * D8f · The transfer form opens on two different accounts.
 *
 * With nothing in the query, both selects fell to their first option — the
 * same account as From and To — so the form exactly as drawn was refused with
 * "A transfer needs two different accounts." Whatever the link fixed, the
 * other side now starts on a different account.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";
import { createAccount } from "../domain/accounts.ts";
import { rupees } from "../core/money.ts";

const actor = { memberId: "m-ravi", source: "ui" as const };

function selected(page: string, name: string): string | undefined {
  const select = new RegExp(`<select id="${name}"[\\s\\S]*?</select>`).exec(page)?.[0] ?? "";
  return /<option value="([^"]+)"\s+selected>/.exec(select)?.[1];
}

describe("D8f · /transfer defaults", () => {
  test("From and To start on different accounts, whichever side a link fixes", async () => {
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    const ids = ["A Bank", "B Bank", "C Card"].map((name, i) => createAccount(db, actor, {
      name, kind: i === 2 ? "credit" : "budget", subtype: i === 2 ? "credit-card" : "savings",
      openingDate: "2026-08-01", openingBalance: i === 2 ? 0 : rupees(10_000),
    }).id);
    const app = await startTestApp(db, { memberId: "m-ravi" });
    try {
      for (const query of ["", `?to=${ids[0]}`, `?from=${ids[1]}`, `?to=${ids[2]}`]) {
        const page = await (await app.get(`/transfer${query}`)).text();
        const from = selected(page, "from_account_id");
        const to = selected(page, "to_account_id");
        assert.ok(from && to, `nothing selected for ${query || "no query"}`);
        assert.notEqual(from, to, `From and To are the same account for ${query || "no query"}`);
        if (query.startsWith("?to=")) assert.equal(to, query.slice(4));
        if (query.startsWith("?from=")) assert.equal(from, query.slice(6));
      }
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });
});
