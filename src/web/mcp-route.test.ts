/**
 * AI-2 · POST /mcp end to end: what an AI app actually gets over HTTP.
 *
 * The protocol rules are tested in src/ai/mcp.test.ts; this is the route —
 * that a read-only token can reach it and nothing else can, that every tool
 * runs for real against a household, that one member's connection never sees
 * another's private things, that masking and the access log happen, and that
 * the AI page is not reachable by any token.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { startTestApp, type TestApp } from "./harness.test-data.ts";
import { mintToken } from "../auth/tokens.ts";
import { execute, queryAll } from "../db/db.ts";
import { buildAnalysisWorld, PRIYA, RAVI, SECRET_NAMES, SECRET_AMOUNTS } from "../ai/analysis.test-data.ts";
import { listAiAccess } from "../ai/access-log.ts";

const MODERN = "2026-07-28";

async function rpc(app: TestApp, secret: string | null, method: string, params: Record<string, unknown> = {}, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": MODERN,
    "Mcp-Method": method,
    ...extra,
  };
  if (secret) headers.Authorization = `Bearer ${secret}`;
  if (typeof params.name === "string") headers["Mcp-Name"] = params.name;
  const res = await fetch(app.baseUrl + "/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method,
      params: { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": MODERN } },
    }),
  });
  const text = await res.text();
  return { res, text, body: text ? JSON.parse(text) as { result?: any; error?: any } : null };
}

function token(db: Parameters<typeof mintToken>[0], member: string, scope: "read" | "read-write" = "read") {
  return mintToken(db, { memberId: member, source: "ui" }, { name: `ai-${member}`, scope });
}

describe("AI-2 · POST /mcp", () => {
  test("no token, or a bad one, is the 401 that starts an AI app's sign-in", async () => {
    const { db } = buildAnalysisWorld({ withPrivate: false });
    const app = await startTestApp(db, { memberId: null });
    try {
      const none = await rpc(app, null, "tools/list");
      assert.equal(none.res.status, 401);
      assert.match(none.res.headers.get("www-authenticate") ?? "", /resource_metadata=/);
      const bad = await rpc(app, "bgt_nonsense", "tools/list");
      assert.equal(bad.res.status, 401);
      assert.match(bad.res.headers.get("www-authenticate") ?? "", /invalid_token/);
    } finally {
      await app.close();
    }
  });

  test("a read-only token lists the tools and can still not write anywhere else", async () => {
    const { db } = buildAnalysisWorld({ withPrivate: false });
    const { secret } = token(db, PRIYA);
    const app = await startTestApp(db, { memberId: null });
    try {
      const list = await rpc(app, secret, "tools/list");
      assert.equal(list.res.status, 200);
      const names = list.body!.result.tools.map((t: { name: string }) => t.name);
      assert.ok(names.includes("overview") && names.includes("transactions") && names.includes("snapshot"));
      assert.equal(names.length, 17);

      // The exemption is /mcp's alone.
      const write = await fetch(app.baseUrl + "/assign", {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}`, Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body: "x=1",
      });
      assert.equal(write.status, 403);
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });

  test("an older client's initialize handshake works too", async () => {
    const { db } = buildAnalysisWorld({ withPrivate: false });
    const { secret } = token(db, PRIYA);
    const app = await startTestApp(db, { memberId: null });
    try {
      const res = await fetch(app.baseUrl + "/mcp", {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }),
      });
      assert.equal(res.status, 200);
      const body = await res.json() as { result: { protocolVersion: string; serverInfo: { name: string } } };
      assert.equal(body.result.protocolVersion, "2025-06-18");
      assert.equal(body.result.serverInfo.name, "pathayam");

      const note = await fetch(app.baseUrl + "/mcp", {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json", "MCP-Protocol-Version": "2025-06-18" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      });
      assert.equal(note.status, 202);

      const get = await fetch(app.baseUrl + "/mcp", { headers: { Authorization: `Bearer ${secret}` } });
      assert.equal(get.status, 405);
    } finally {
      await app.close();
    }
  });

  test("every tool runs for Priya, and none of Ravi's private things reach her", async () => {
    const { db } = buildAnalysisWorld();
    const { secret, token: t } = token(db, PRIYA);
    const app = await startTestApp(db, { memberId: null });
    try {
      const list = await rpc(app, secret, "tools/list");
      const today = new Date().toISOString().slice(0, 10);
      const yearAgo = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);
      const argsFor: Record<string, Record<string, unknown>> = {
        spending: { from: yearAgo, to: today },
        loan_schedule: { loan_id: "does-not-exist" },
        explain: { what: "ready_to_assign" },
      };
      let everything = "";
      for (const tool of list.body!.result.tools as { name: string }[]) {
        const call = await rpc(app, secret, "tools/call", { name: tool.name, arguments: argsFor[tool.name] ?? {} });
        assert.equal(call.res.status, 200, tool.name);
        assert.ok(call.body!.result, `${tool.name}: ${call.text.slice(0, 200)}`);
        if (tool.name === "loan_schedule") {
          assert.equal(call.body!.result.isError, true);
        } else {
          assert.equal(call.body!.result.isError, false, `${tool.name}: ${call.body!.result.content[0].text.slice(0, 200)}`);
        }
        everything += call.text;
      }
      assert.deepEqual(SECRET_NAMES.filter((s) => everything.includes(s)), []);
      assert.deepEqual(SECRET_AMOUNTS.filter((s) => everything.includes(s)), []);
      assert.deepEqual(app.failures, []);

      // AI-4 · and each call left a line in Priya's log, none in Ravi's.
      const log = listAiAccess(db, PRIYA, 100);
      assert.equal(log.length, 17);
      assert.ok(log.every((r) => r.token_id === t.id));
      assert.equal(listAiAccess(db, RAVI).length, 0);
    } finally {
      await app.close();
    }
  });

  test("a masked connection is sent no UPI IDs or account numbers", async () => {
    const { db } = buildAnalysisWorld({ withPrivate: false });
    const masked = token(db, PRIYA);
    const plain = token(db, PRIYA);
    execute(db, `UPDATE api_tokens SET redact = 1 WHERE id = ?`, masked.token.id);
    // A narration with a UPI handle and a long reference, as a bank writes them.
    const txn = queryAll<{ id: string }>(db, `SELECT id FROM transactions ORDER BY date DESC LIMIT 1`)[0]!;
    execute(db, `UPDATE transactions SET memo = ? WHERE id = ?`, "UPI/priya.k@okhdfcbank/412345678901", txn.id);
    const app = await startTestApp(db, { memberId: null });
    try {
      const args = { name: "transactions", arguments: { text: "okhdfcbank" } };
      const open = await rpc(app, plain.secret, "tools/call", args);
      assert.match(open.text, /priya\.k@okhdfcbank/);
      const hidden = await rpc(app, masked.secret, "tools/call", args);
      assert.equal(hidden.body!.result.isError, false);
      assert.doesNotMatch(hidden.text, /priya\.k@|412345678901/);
      assert.match(hidden.text, /•••@okhdfcbank/);
    } finally {
      await app.close();
    }
  });

  test("a browser page from another origin is refused even with a token", async () => {
    const { db } = buildAnalysisWorld({ withPrivate: false });
    const { secret } = token(db, PRIYA);
    const app = await startTestApp(db, { memberId: null });
    try {
      const res = await rpc(app, secret, "tools/list", {}, { Origin: "https://evil.example" });
      assert.equal(res.res.status, 403);
    } finally {
      await app.close();
    }
  });

  test("no token can open Connect an AI or mint itself a sibling there", async () => {
    const { db } = buildAnalysisWorld({ withPrivate: false });
    const { secret } = token(db, PRIYA, "read-write");
    const app = await startTestApp(db, { memberId: null });
    try {
      for (const method of ["GET", "POST"]) {
        const res = await fetch(app.baseUrl + "/tokens/ai", {
          method,
          headers: { Authorization: `Bearer ${secret}`, Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
          body: method === "POST" ? "name=x" : undefined,
        });
        assert.equal(res.status, 403, method);
      }
    } finally {
      await app.close();
    }
  });
});

describe("AI-5 · Connect an AI", () => {
  test("mints an expiring, read-only, masked token and shows the set-up commands once", async () => {
    const { db } = buildAnalysisWorld({ withPrivate: false });
    const app = await startTestApp(db, { memberId: PRIYA });
    try {
      const page = await app.get("/tokens/ai");
      assert.equal(page.status, 200);
      assert.match(await page.text(), /\/mcp/);

      const res = await app.post("/tokens/ai", { name: "Claude Code", redact: "1", expires_in_days: "30" });
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.match(html, /claude mcp add --transport http pathayam/);
      assert.match(html, /gemini mcp add/);
      const row = queryAll<{ scope: string; redact: number; for_ai: number; expires_at: string | null }>(
        db, `SELECT scope, redact, for_ai, expires_at FROM api_tokens WHERE name = 'Claude Code'`,
      )[0]!;
      assert.deepEqual([row.scope, row.redact, row.for_ai], ["read", 1, 1]);
      assert.ok(row.expires_at);

      // A forged "never" falls back to 90 days rather than never expiring.
      await app.post("/tokens/ai", { name: "Forever", expires_in_days: "" });
      const forever = queryAll<{ expires_at: string | null; redact: number }>(db, `SELECT expires_at, redact FROM api_tokens WHERE name = 'Forever'`)[0]!;
      assert.ok(forever.expires_at);
      assert.equal(forever.redact, 0);

      const again = await (await app.get("/tokens/ai")).text();
      assert.match(again, /Claude Code/);
      assert.doesNotMatch(again, /bgt_/);
    } finally {
      await app.close();
    }
  });
});

describe("AI-7 · with FEATURE_AI off (a hosted Solo instance)", () => {
  test("every way in for an AI app is not there, and nothing links to it", async () => {
    const { db } = buildAnalysisWorld({ withPrivate: false });
    const { secret } = token(db, PRIYA);
    const off = { features: { loans: true, assets: true, multiCurrency: false, ai: false } };
    const anon = await startTestApp(db, { memberId: null, config: off });
    try {
      assert.equal((await rpc(anon, secret, "tools/list")).res.status, 404);
      assert.equal((await rpc(anon, null, "tools/list")).res.status, 404, "no 401 to start a sign-in");
      for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-authorization-server"]) {
        assert.equal((await fetch(anon.baseUrl + path)).status, 404, path);
      }
      const reg = await fetch(anon.baseUrl + "/oauth/register", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_name: "x", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] }),
      });
      assert.equal(reg.status, 404);
    } finally {
      await anon.close();
    }

    const member = await startTestApp(db, { memberId: PRIYA, config: off });
    try {
      assert.equal((await member.get("/tokens/ai")).status, 404);
      assert.equal((await member.get("/oauth/authorize?client_id=x")).status, 404);
      assert.doesNotMatch(await (await member.get("/more")).text(), /\/tokens\/ai/);
      assert.doesNotMatch(await (await member.get("/tokens")).text(), /\/tokens\/ai/);
      // The summary meant for AI tools goes with them; the full export stays.
      assert.equal((await member.get("/export/analysis.json")).status, 404);
      assert.doesNotMatch(await (await member.get("/health")).text(), /analysis\.json/);
      assert.equal((await member.get("/export.json")).status, 200);
      assert.deepEqual(member.failures, []);
    } finally {
      await member.close();
    }
  });

  test("AI-4 · an AI connection's token stops working everywhere, while a script's keeps working", async () => {
    const { db } = buildAnalysisWorld({ withPrivate: false });
    const ai = token(db, PRIYA);
    execute(db, `UPDATE api_tokens SET for_ai = 1 WHERE id = ?`, ai.token.id);
    const script = token(db, PRIYA);
    // API tokens stay on: only the AI module is off.
    const app = await startTestApp(db, { memberId: null, config: { features: { loans: true, assets: true, multiCurrency: false, ai: false } } });
    try {
      for (const path of ["/export.json", "/accounts", "/export.csv"]) {
        const res = await fetch(app.baseUrl + path, { headers: { Authorization: `Bearer ${ai.secret}`, Accept: "application/json" } });
        assert.equal(res.status, 403, path);
      }
      const ok = await fetch(app.baseUrl + "/export.json", { headers: { Authorization: `Bearer ${script.secret}`, Accept: "application/json" } });
      assert.equal(ok.status, 200);
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
    }
  });
});
