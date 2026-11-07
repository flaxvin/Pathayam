/**
 * PLAN-1 · What a plan limits, beyond pages disappearing: how many members, a
 * token minted before API tokens were switched off, the import box's two
 * modules, and how long backups are kept.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, utimesSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execute, queryOne } from "../db/db.ts";
import { nowIST } from "../core/dates.ts";
import { createAccount } from "../domain/accounts.ts";
import { mintToken } from "../auth/tokens.ts";
import { removeMember } from "../auth/sessions.ts";
import { pruneBackupsByAge } from "../ops/backup.ts";
import { YNAB_DAY_FIRST } from "../import/budget-apps.test-data.ts";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";

const memberCount = (db: ReturnType<typeof freshDb>) =>
  queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM members WHERE removed_at IS NULL`)!.n;

describe("PLAN-1 · MAX_MEMBERS", () => {
  test("Solo (1): adding anybody is refused, and Settings offers no form to try", async () => {
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    const app = await startTestApp(db, { memberId: "m-ravi", config: { limits: { maxMembers: 1, backupRetentionDays: 30 } } });
    try {
      const res = await app.post("/members/invite", { email: "priya@example.com" });
      assert.equal(res.status, 422);
      assert.match(await res.text(), /for one person/);
      assert.equal(memberCount(db), 1);
      const settings = await (await app.get("/settings")).text();
      assert.doesNotMatch(settings, /action="\/members\/invite"/);
      assert.match(settings, /This instance is for one person/);
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });

  test("a limit of 2 lets one more in, then refuses — including adding somebody back", async () => {
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    const app = await startTestApp(db, { memberId: "m-ravi", config: { limits: { maxMembers: 2, backupRetentionDays: null } } });
    try {
      assert.equal((await app.post("/members/invite", { email: "priya@example.com" })).status, 303);
      assert.equal(memberCount(db), 2);
      assert.equal((await app.post("/members/invite", { email: "anil@example.com" })).status, 422);
      // Asking for somebody already in is not an addition.
      assert.equal((await app.post("/members/invite", { email: "priya@example.com" })).status, 303);

      const priya = queryOne<{ id: string }>(db, `SELECT id FROM members WHERE email = 'priya@example.com'`)!.id;
      removeMember(db, { memberId: "m-ravi", source: "ui" }, priya);
      execute(db, `INSERT INTO members (id,email,name,created_at) VALUES ('m-anu','anu@example.com','Anu',?)`, nowIST());
      assert.equal(memberCount(db), 2);
      const back = await app.post("/members/invite", { email: "priya@example.com" });
      assert.equal(back.status, 422, "adding back is one more member too");
      assert.doesNotMatch(await (await app.get("/settings")).text(), /Add back/);
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });

  test("a household already over the limit keeps everyone; it only cannot add", async () => {
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    seedMember(db, "m-priya", "Priya");
    seedMember(db, "m-anil", "Anil");
    const app = await startTestApp(db, { memberId: "m-priya", config: { limits: { maxMembers: 1, backupRetentionDays: 30 } } });
    try {
      assert.equal((await app.get("/")).status, 200, "a member past the limit still signs in");
      assert.equal((await app.post("/members/invite", { email: "meera@example.com" })).status, 422);
      assert.equal(memberCount(db), 3);
    } finally {
      await app.close();
    }
  });
});

describe("PLAN-1 · FEATURE_API_TOKENS off", () => {
  test("a token minted earlier stops working everywhere but /mcp, and is kept", async () => {
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    const { secret } = mintToken(db, { memberId: "m-ravi", source: "ui" }, { name: "script", scope: "read" });
    const app = await startTestApp(db, { memberId: null, config: { features: { apiTokens: false } } });
    const bearer = { Authorization: `Bearer ${secret}`, Accept: "application/json" };
    try {
      const res = await fetch(app.baseUrl + "/accounts", { headers: bearer });
      assert.equal(res.status, 403);
      assert.match(await res.text(), /not available on this instance/);
      // AI connections are their own module (FEATURE_AI), on here.
      const mcp = await fetch(app.baseUrl + "/mcp", {
        method: "POST",
        headers: { ...bearer, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }),
      });
      assert.notEqual(mcp.status, 403);
      assert.notEqual(mcp.status, 401);
      assert.equal(queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM api_tokens WHERE revoked_at IS NULL`)!.n, 1);
    } finally {
      await app.close();
    }
    // Switched back on, the same token works again.
    const again = await startTestApp(db, { memberId: null });
    try {
      assert.equal((await fetch(again.baseUrl + "/accounts", { headers: bearer })).status, 200);
    } finally {
      await again.close();
    }
  });
});

describe("PLAN-1 · the import box serves two modules", () => {
  const world = () => {
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    const account = createAccount(db, { memberId: "m-ravi", source: "ui" }, {
      name: "ZZ Savings", kind: "budget", subtype: "savings", openingDate: "2026-08-01", openingBalance: 0,
    }).id;
    return { db, account };
  };
  const BANK_CSV = "Date,Narration,Withdrawal Amt.,Deposit Amt.\n01-08-2026,SALARY,,145000.00\n";

  test("bank CSV off, YNAB on: the bank file is refused by name, the YNAB file goes through", async () => {
    const { db, account } = world();
    const app = await startTestApp(db, { memberId: "m-ravi", config: { features: { importCsv: false } } });
    try {
      const page = await (await app.get("/import")).text();
      assert.match(page, /Paste the YNAB or Actual Budget export/);
      assert.doesNotMatch(page, /Paste the CSV/);
      const bank = await (await app.post("/import", { account_id: account, csv: BANK_CSV })).text();
      assert.match(bank, /Bank CSV import is not available on this instance/);
      const ynab = await (await app.post("/import", { account_id: account, csv: YNAB_DAY_FIRST })).text();
      assert.match(ynab, /Import from YNAB/);
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });

  test("YNAB off: its export is refused, and the page does not offer it", async () => {
    const { db, account } = world();
    const app = await startTestApp(db, { memberId: "m-ravi", config: { features: { importBudgetApp: false } } });
    try {
      assert.doesNotMatch(await (await app.get("/import")).text(), /Moving from YNAB/);
      const ynab = await (await app.post("/import", { account_id: account, csv: YNAB_DAY_FIRST })).text();
      assert.match(ynab, /Importing from YNAB is not available on this instance/);
      assert.equal((await app.post("/import/budget-app", { csv: YNAB_DAY_FIRST })).status, 404);
    } finally {
      await app.close();
    }
  });

  test("PDF off: no PDF form, and the route is gone", async () => {
    const { db } = world();
    const app = await startTestApp(db, { memberId: "m-ravi", config: { features: { importPdf: false } } });
    try {
      assert.doesNotMatch(await (await app.get("/import")).text(), /action="\/import\/pdf"/);
      assert.equal((await app.post("/import/pdf", {})).status, 404);
    } finally {
      await app.close();
    }
  });
});

describe("PLAN-1 · BACKUP_RETENTION_DAYS", () => {
  test("every backup of the last two days, then one a day back to the limit, and never the newest", () => {
    const dir = mkdtempSync(join(tmpdir(), "pathayam-retention-"));
    try {
      const now = new Date("2026-11-07T12:00:00Z");
      const HOUR = 60 * 60 * 1000;
      // Every six hours for 40 days.
      for (let h = 0; h < 40 * 24; h += 6) {
        const path = join(dir, `b-${String(h).padStart(4, "0")}.sqlite`);
        writeFileSync(path, "x");
        const t = new Date(now.getTime() - h * HOUR);
        utimesSync(path, t, t);
      }
      pruneBackupsByAge(dir, 30, now);
      const left = readdirSync(dir).map((f) => Number(f.slice(2, 6))).sort((a, b) => a - b);
      assert.ok(left.every((h) => h < 30 * 24), "nothing older than 30 days");
      assert.equal(left.filter((h) => h < 48).length, 8, "all four a day for two days");
      // From two days back to thirty, one a day: 28 or 29 depending on where the IST days fall.
      const older = left.filter((h) => h >= 48).length;
      assert.ok(older >= 27 && older <= 29, `${older} daily backups`);

      // A box that has been down past the window still keeps its last backup.
      const lone = mkdtempSync(join(tmpdir(), "pathayam-retention-"));
      const old = join(lone, "only.sqlite");
      writeFileSync(old, "x");
      const t = new Date(now.getTime() - 100 * 24 * HOUR);
      utimesSync(old, t, t);
      assert.equal(pruneBackupsByAge(lone, 30, now), 0);
      rmSync(lone, { recursive: true });
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
