/**
 * AI-4 · /export/analysis.json over HTTP: a read token reaches it, nobody
 * signed out does, and it carries nothing private to anybody else.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { startTestApp } from "./harness.test-data.ts";
import { mintToken } from "../auth/tokens.ts";
import { todayIST } from "../core/dates.ts";
import { execute } from "../db/db.ts";
import { createAccount } from "../domain/accounts.ts";
import { rupees, type Paise } from "../core/money.ts";
import { buildAnalysisWorld, PRIYA, SECRET_NAMES, SECRET_AMOUNTS } from "../ai/analysis.test-data.ts";

describe("AI-4 · the analysis snapshot export", () => {
  test("a read-only token downloads Priya's snapshot, with none of Ravi's private things", async () => {
    const { db } = buildAnalysisWorld();
    const { secret } = mintToken(db, { memberId: PRIYA, source: "ui" }, { name: "ai", scope: "read" });
    const app = await startTestApp(db, { memberId: null });
    try {
      const res = await app.get("/export/analysis.json?months=3", {
        headers: { Authorization: `Bearer ${secret}`, Accept: "application/json" },
      });
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
      assert.equal(
        res.headers.get("content-disposition"),
        `attachment; filename="pathayam-analysis-${todayIST()}.json"`,
      );
      const text = await res.text();
      const body = JSON.parse(text) as { member_name: string; currency: string; months_covered: { count: number } };
      assert.equal(body.member_name, "Priya");
      assert.equal(body.currency, "INR");
      assert.equal(body.months_covered.count, 4);
      assert.deepEqual(SECRET_NAMES.filter((s) => text.includes(s)), []);
      assert.deepEqual(SECRET_AMOUNTS.filter((s) => text.includes(s)), []);
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });

  test("AI-3 · a masked AI connection's token gets it masked, as the snapshot tool would", async () => {
    const { db } = buildAnalysisWorld({ withPrivate: false });
    createAccount(db, { memberId: PRIYA, source: "ui" }, {
      name: "SBI 50100234567890", kind: "budget", subtype: "savings",
      openingDate: "2025-01-01", openingBalance: rupees(100) as Paise,
    });
    const masked = mintToken(db, { memberId: PRIYA, source: "ui" }, { name: "Claude Code", scope: "read" });
    execute(db, `UPDATE api_tokens SET for_ai = 1, redact = 1 WHERE id = ?`, masked.token.id);
    const plain = mintToken(db, { memberId: PRIYA, source: "ui" }, { name: "Gemini CLI", scope: "read" });
    execute(db, `UPDATE api_tokens SET for_ai = 1, redact = 0 WHERE id = ?`, plain.token.id);
    const app = await startTestApp(db, { memberId: null });
    try {
      const get = async (secret: string) => (await app.get("/export/analysis.json", {
        headers: { Authorization: `Bearer ${secret}`, Accept: "application/json" },
      })).text();
      const hidden = await get(masked.secret);
      assert.ok(!hidden.includes("50100234567890"), "the account number left whole");
      assert.ok(hidden.includes("SBI ••••7890"));
      assert.ok((await get(plain.secret)).includes("SBI 50100234567890"), "unmasked when not asked");
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });

  test("months out of range is refused, and nobody signed out gets anything", async () => {
    const { db } = buildAnalysisWorld({ withPrivate: false });
    const signedIn = await startTestApp(db, { memberId: PRIYA });
    try {
      for (const bad of ["0", "37", "abc", "1.5"]) {
        const res = await signedIn.get(`/export/analysis.json?months=${bad}`);
        assert.equal(res.status, 422, `months=${bad}`);
      }
      assert.equal((await signedIn.get("/export/analysis.json")).status, 200);
    } finally {
      await signedIn.close();
    }

    const anon = await startTestApp(db, { memberId: null });
    try {
      const json = await anon.get("/export/analysis.json", { headers: { Accept: "application/json" } });
      assert.equal(json.status, 401);
      const page = await anon.get("/export/analysis.json");
      assert.ok([302, 303].includes(page.status), `was ${page.status}`);
      assert.match(page.headers.get("location") ?? "", /^\/signin/);
    } finally {
      await anon.close();
    }
  });

  test("with the assets feature off, those sections say so", async () => {
    const { db } = buildAnalysisWorld({ withPrivate: false });
    const app = await startTestApp(db, {
      memberId: PRIYA, config: { features: { loans: false, assets: false, multiCurrency: false } },
    });
    try {
      const body = await (await app.get("/export/analysis.json")).json() as Record<string, { enabled?: boolean }>;
      assert.equal(body.portfolio!.enabled, false);
      assert.equal(body.net_worth!.enabled, false);
      assert.equal(body.loans!.enabled, false);
    } finally {
      await app.close();
    }
  });
});
