/**
 * AIW · An AI connection making changes, over HTTP: the three locks, each
 * tool, suggestions and Review, the caps, privacy, the OAuth consent, the
 * confinement to /mcp, undoing a day of one AI's changes, and Activity.
 */

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { startTestApp, type TestApp, type TestConfigOverrides } from "./harness.test-data.ts";
import { mintToken, resetTokenRateLimits } from "../auth/tokens.ts";
import { resetOAuthRateLimits } from "../auth/oauth.ts";
import { execute, queryAll, queryOne } from "../db/db.ts";
import { buildAnalysisWorld, PRIYA, RAVI } from "../ai/analysis.test-data.ts";
import { createCategory, listGroups, getAssigned } from "../domain/budget.ts";
import { createAccount } from "../domain/accounts.ts";
import { getTransaction } from "../domain/transactions.ts";
import { rupees, type Paise } from "../core/money.ts";
import { todayIST, monthOf, nowIST } from "../core/dates.ts";
import { aiIdempotencyKey, AI_DAILY_WRITE_CAP, AI_PENDING_CAP } from "../ai/writes.ts";
import type { DB } from "../db/db.ts";

const MODERN = "2026-07-28";
const STANDARD: TestConfigOverrides = { aiWrite: "standard" };
const FULL: TestConfigOverrides = { aiWrite: "full" };
const WRITE_TOOLS = ["set_envelope", "split_transaction", "set_memo", "set_payee_default", "add_transaction", "assign_to_envelope", "transfer"];

async function rpc(app: TestApp, secret: string, method: string, params: Record<string, unknown> = {}) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json", Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": MODERN, "Mcp-Method": method, Authorization: `Bearer ${secret}`,
  };
  if (typeof params.name === "string") headers["Mcp-Name"] = params.name;
  const res = await fetch(app.baseUrl + "/mcp", {
    method: "POST", headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": MODERN } } }),
  });
  const text = await res.text();
  return { res, text, body: text ? JSON.parse(text) as { result?: any; error?: any } : null };
}

async function call(app: TestApp, secret: string, name: string, args: Record<string, unknown>) {
  const r = await rpc(app, secret, "tools/call", { name, arguments: args });
  assert.equal(r.res.status, 200, r.text);
  const result = r.body!.result;
  return { isError: result.isError as boolean, text: result.content[0].text as string, data: result.structuredContent as any };
}

/** A token as Connect an AI makes one. */
function aiToken(db: DB, member: string, scope: "read" | "read-write" = "read-write", name = "Claude Code") {
  const minted = mintToken(db, { memberId: member, source: "ui" }, { name, scope, expiresInDays: 30 });
  execute(db, `UPDATE api_tokens SET for_ai = 1 WHERE id = ?`, minted.token.id);
  return minted;
}

function world() {
  const w = buildAnalysisWorld();
  const group = listGroups(w.db).find((g) => g.name === "Everyday")!;
  const dining = createCategory(w.db, { memberId: PRIYA, source: "ui" }, { groupId: group.id, name: "Dining" });
  const wallet = createAccount(w.db, { memberId: PRIYA, source: "ui" }, {
    name: "Wallet", kind: "budget", subtype: "cash", openingDate: "2025-01-01", openingBalance: rupees(500) as Paise,
  });
  const txn = queryAll<{ id: string; amount: number }>(
    w.db, `SELECT id, amount FROM transactions WHERE account_id = ? AND deleted_at IS NULL ORDER BY date DESC LIMIT 1`,
    w.ids.householdAccount,
  )[0]!;
  return { ...w, dining: dining.id, wallet: wallet.id, txn: txn.id, txnAmount: txn.amount };
}

async function toolNames(app: TestApp, secret: string): Promise<string[]> {
  const list = await rpc(app, secret, "tools/list");
  return list.body!.result.tools.map((t: { name: string }) => t.name);
}

beforeEach(() => { resetTokenRateLimits(); resetOAuthRateLimits(); });

describe("AIW · which connections are offered the change tools", () => {
  test("only an AI token the member allowed to write, on a deployment that allows it", async () => {
    const w = world();
    const writer = aiToken(w.db, PRIYA, "read-write");
    const reader = aiToken(w.db, PRIYA, "read");
    // A script's read-write token is not an AI connection the member opted in.
    const script = mintToken(w.db, { memberId: PRIYA, source: "ui" }, { name: "script", scope: "read-write" });

    const off = await startTestApp(w.db, { memberId: null });
    try {
      const names = await toolNames(off, writer.secret);
      assert.equal(names.length, 17);
      assert.ok(!names.some((n) => WRITE_TOOLS.includes(n)));
      const unknown = await rpc(off, writer.secret, "tools/call", { name: "set_memo", arguments: { transaction_id: w.txn, memo: "x" } });
      assert.match(unknown.text, /Unknown tool/);
    } finally { await off.close(); }

    const on = await startTestApp(w.db, { memberId: null, config: STANDARD });
    try {
      assert.equal((await toolNames(on, reader.secret)).length, 17);
      assert.equal((await toolNames(on, script.secret)).length, 17);
      const list = await rpc(on, writer.secret, "tools/list");
      const tools = list.body!.result.tools as { name: string; annotations: Record<string, boolean> }[];
      assert.deepEqual(tools.slice(17).map((t) => t.name), WRITE_TOOLS);
      for (const t of tools) {
        const isWrite = WRITE_TOOLS.includes(t.name);
        assert.equal(t.annotations.readOnlyHint, !isWrite, t.name);
        assert.equal(t.annotations.destructiveHint, false, t.name);
      }
      // The instructions say what it may never do.
      const discover = await rpc(on, writer.secret, "server/discover");
      assert.match(discover.body!.result.instructions, /never delete anything/);
    } finally { await on.close(); }
  });

  test("Solo has no AI connections, so AI_WRITE changes nothing there", async () => {
    const w = world();
    const writer = aiToken(w.db, PRIYA);
    const { PLAN_PRESETS } = await import("../features.ts");
    const app = await startTestApp(w.db, { memberId: null, config: { ...FULL, plan: "solo", features: PLAN_PRESETS.solo.features } });
    try {
      const res = await rpc(app, writer.secret, "tools/list");
      assert.equal(res.res.status, 404);
    } finally { await app.close(); }
  });

  test("a read-write AI token still cannot reach a REST write route", async () => {
    const w = world();
    const writer = aiToken(w.db, PRIYA);
    const app = await startTestApp(w.db, { memberId: null, config: FULL });
    try {
      for (const path of ["/assign", "/add", `/transaction/${w.txn}/delete`, "/transfer"]) {
        const res = await fetch(app.baseUrl + path, {
          method: "POST",
          headers: { Authorization: `Bearer ${writer.secret}`, Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
          body: `category_id=${w.ids.groceries}&amount=1`,
        });
        assert.equal(res.status, 403, path);
      }
      assert.equal(getTransaction(w.db, w.txn)!.deleted_at, null);
      // Reading stays as it was.
      const read = await fetch(app.baseUrl + "/accounts", { headers: { Authorization: `Bearer ${writer.secret}`, Accept: "application/json" } });
      assert.notEqual(read.status, 403);
    } finally { await app.close(); }
  });
});

describe("AIW · direct changes", () => {
  test("each one is made through the domain, with source ai, the connection named, and undoable", async () => {
    const w = world();
    const writer = aiToken(w.db, PRIYA);
    const app = await startTestApp(w.db, { memberId: PRIYA, config: STANDARD });
    try {
      const filed = await call(app, writer.secret, "set_envelope", { transaction_id: w.txn, category_id: w.dining });
      assert.equal(filed.isError, false, filed.text);
      assert.equal(getTransaction(w.db, w.txn)!.category_id, w.dining);
      const event = queryOne<{ source: string; source_detail: string; idempotency_key: string; actor_member_id: string }>(
        w.db, `SELECT source, source_detail, idempotency_key, actor_member_id FROM events WHERE id = ?`, filed.data.event_id,
      )!;
      assert.deepEqual({ ...event }, {
        source: "ai", source_detail: "Claude Code", idempotency_key: aiIdempotencyKey(writer.token.id), actor_member_id: PRIYA,
      });

      const memo = await call(app, writer.secret, "set_memo", { transaction_id: w.txn, memo: "Dinner with Ravi" });
      assert.equal(memo.isError, false, memo.text);
      assert.equal(getTransaction(w.db, w.txn)!.memo, "Dinner with Ravi");

      const half = Math.abs(w.txnAmount) / 200;
      const split = await call(app, writer.secret, "split_transaction", {
        transaction_id: w.txn,
        lines: [{ category_id: w.dining, amount: half }, { category_id: w.ids.groceries, amount: Math.abs(w.txnAmount) / 100 - half }],
      });
      assert.equal(split.isError, false, split.text);
      assert.equal(getTransaction(w.db, w.txn)!.is_split, 1);
      const wrong = await call(app, writer.secret, "split_transaction", {
        transaction_id: w.txn, lines: [{ category_id: w.dining, amount: 1 }, { category_id: w.ids.groceries, amount: 1 }],
      });
      assert.equal(wrong.isError, true);
      assert.match(wrong.text, /add up to it exactly/);

      const payee = await call(app, writer.secret, "set_payee_default", { payee: "dmart", category_id: w.dining, why: "It is the food court" });
      assert.equal(payee.isError, false, payee.text);
      const rule = queryOne<{ proposed: number }>(w.db, `SELECT proposed FROM rules WHERE id = ?`, payee.data.rule_id)!;
      assert.equal(rule.proposed, 1, "a proposal, never a rule that files on its own");
      const again = await call(app, writer.secret, "set_payee_default", { payee: "DMart", category_id: w.dining });
      assert.equal(again.isError, true);
      assert.match(again.text, /already waiting in Review/);

      // Undone one at a time in Activity, like any other change.
      const res = await app.post(`/activity/${memo.data.event_id}/undo`, { force: "1" });
      assert.equal(res.status, 303);
      assert.equal(getTransaction(w.db, w.txn)!.memo, null);

      // And every call, its arguments included, is in the access log.
      const logged = queryAll<{ tool: string; wrote: number; connection_id: string }>(
        w.db, `SELECT tool, wrote, connection_id FROM ai_access_log WHERE wrote = 1 ORDER BY id`,
      );
      assert.deepEqual(logged.map((l) => l.tool), ["set_envelope", "set_memo", "split_transaction", "set_payee_default"]);
      assert.ok(logged.every((l) => l.connection_id === writer.token.id));
      assert.deepEqual(app.failures, []);
    } finally { await app.close(); }
  });

  test("another member's private account and envelope are not found", async () => {
    const w = world();
    const writer = aiToken(w.db, PRIYA);
    const app = await startTestApp(w.db, { memberId: null, config: FULL });
    try {
      const privateTxn = queryAll<{ id: string }>(w.db, `SELECT id FROM transactions WHERE account_id = ?`, w.ids.privateAccount!)[0]!.id;
      const cases: [string, Record<string, unknown>][] = [
        ["set_envelope", { transaction_id: privateTxn, category_id: w.dining }],
        ["set_envelope", { transaction_id: w.txn, category_id: w.ids.privateCategory! }],
        ["set_memo", { transaction_id: privateTxn, memo: "seen" }],
        ["assign_to_envelope", { category_id: w.ids.privateCategory!, amount: 5, why: "x" }],
        ["transfer", { from_account_id: w.ids.privateAccount!, to_account_id: w.wallet, amount: 5, why: "x" }],
        ["add_transaction", { account_id: w.ids.privateAccount!, amount: 5, direction: "in", why: "x" }],
        ["set_payee_default", { payee: "Grimalkin Therapy Clinic", category_id: w.dining }],
      ];
      for (const [name, args] of cases) {
        const r = await call(app, writer.secret, name, args);
        assert.equal(r.isError, true, name);
        assert.match(r.text, /not found/, `${name}: ${r.text}`);
      }
      assert.equal(queryOne<{ n: number }>(w.db, `SELECT COUNT(*) AS n FROM events WHERE source = 'ai'`)!.n, 0);
    } finally { await app.close(); }
  });
});

describe("AIW · suggestions, and full mode", () => {
  test("standard: a suggestion changes nothing until it is approved in Review", async () => {
    const w = world();
    const writer = aiToken(w.db, PRIYA);
    const app = await startTestApp(w.db, { memberId: PRIYA, config: STANDARD });
    try {
      const count = () => queryOne<{ n: number }>(w.db, `SELECT COUNT(*) AS n FROM transactions WHERE account_id = ?`, w.wallet)!.n;
      const s = await call(app, writer.secret, "add_transaction", {
        account_id: w.wallet, amount: 120, direction: "out", payee: "Chai stall", category_id: w.dining, why: "You told me you bought tea",
      });
      assert.equal(s.isError, false, s.text);
      assert.equal(s.data.status, "pending");
      assert.match(s.data.message, /waiting for approval in Review/);
      assert.equal(count(), 0);

      // The domain's refusals are made now, not at Approve.
      const bad = await call(app, writer.secret, "add_transaction", { account_id: w.wallet, amount: 5, direction: "out", why: "no envelope" });
      assert.equal(bad.isError, true);
      const noWhy = await call(app, writer.secret, "assign_to_envelope", { category_id: w.dining, amount: 5 });
      assert.equal(noWhy.isError, true);

      const review = await (await app.get("/review")).text();
      assert.match(review, /Suggested by your AI/);
      assert.match(review, /You told me you bought tea/);

      // Ravi does not see Priya's AI's suggestions, and cannot decide them.
      const ravi = await startTestApp(w.db, { memberId: RAVI, config: STANDARD });
      try {
        assert.doesNotMatch(await (await ravi.get("/review")).text(), /You told me you bought tea/);
        assert.equal((await ravi.post(`/review/ai/${s.data.suggestion_id}/approve`)).status, 404);
      } finally { await ravi.close(); }

      const approved = await app.post(`/review/ai/${s.data.suggestion_id}/approve`);
      assert.equal(approved.status, 303);
      assert.equal(count(), 1);
      const row = queryOne<{ status: string; decided_by: string; result_event_id: string }>(
        w.db, `SELECT status, decided_by, result_event_id FROM ai_suggestions WHERE id = ?`, s.data.suggestion_id,
      )!;
      assert.equal(row.status, "approved");
      assert.equal(row.decided_by, PRIYA);
      const event = queryOne<{ source: string; source_detail: string }>(w.db, `SELECT source, source_detail FROM events WHERE id = ?`, row.result_event_id)!;
      assert.equal(event.source, "ai");
      assert.match(event.source_detail, /Claude Code, suggestion approved/);

      // Rejected: nothing happens.
      const month = monthOf(todayIST());
      const before = getAssigned(w.db, month, w.dining);
      const a = await call(app, writer.secret, "assign_to_envelope", { category_id: w.dining, amount: 700, why: "Eating out more" });
      assert.equal(a.isError, false, a.text);
      assert.equal((await app.post(`/review/ai/${a.data.suggestion_id}/reject`)).status, 303);
      assert.equal(getAssigned(w.db, month, w.dining), before);
      assert.equal(queryOne<{ status: string }>(w.db, `SELECT status FROM ai_suggestions WHERE id = ?`, a.data.suggestion_id)!.status, "rejected");
      assert.equal((await app.post(`/review/ai/${a.data.suggestion_id}/approve`)).status, 422);
      assert.deepEqual(app.failures, []);
    } finally { await app.close(); }
  });

  test("full: the same three tools change the budget directly", async () => {
    const w = world();
    const writer = aiToken(w.db, PRIYA);
    const app = await startTestApp(w.db, { memberId: null, config: FULL });
    try {
      const month = monthOf(todayIST());
      const a = await call(app, writer.secret, "assign_to_envelope", { category_id: w.dining, amount: 700, why: "Eating out" });
      assert.equal(a.isError, false, a.text);
      assert.ok(a.data.event_id);
      assert.equal(getAssigned(w.db, month, w.dining), rupees(700));
      const t = await call(app, writer.secret, "transfer", { from_account_id: w.ids.householdAccount, to_account_id: w.wallet, amount: 200, why: "ATM" });
      assert.equal(t.isError, false, t.text);
      const add = await call(app, writer.secret, "add_transaction", { account_id: w.wallet, amount: 50, direction: "out", category_id: w.dining, why: "Snack" });
      assert.equal(add.isError, false, add.text);
      assert.equal(queryOne<{ n: number }>(w.db, `SELECT COUNT(*) AS n FROM ai_suggestions`)!.n, 0);
      assert.equal(queryOne<{ n: number }>(w.db, `SELECT COUNT(*) AS n FROM transactions WHERE account_id = ? AND deleted_at IS NULL`, w.wallet)!.n, 2);
    } finally { await app.close(); }
  });

  test("caps: a hundred writes a day, fifty suggestions waiting", async () => {
    const w = world();
    const writer = aiToken(w.db, PRIYA);
    const app = await startTestApp(w.db, { memberId: null, config: STANDARD });
    try {
      for (let i = 0; i < AI_PENDING_CAP; i++) {
        execute(w.db,
          `INSERT INTO ai_suggestions (id, member_id, connection_id, token_id, token_name, tool, arguments, summary, why, status, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,'pending',?)`,
          `s${i}`, PRIYA, writer.token.id, writer.token.id, "Claude Code", "assign_to_envelope", "{}", "x", "y", "2020-01-01T00:00:00+05:30");
      }
      const full = await call(app, writer.secret, "assign_to_envelope", { category_id: w.dining, amount: 5, why: "x" });
      assert.equal(full.isError, true);
      assert.match(full.text, /already waiting in Review/);
      // A direct change is still allowed; the pending cap is for suggestions.
      assert.equal((await call(app, writer.secret, "set_memo", { transaction_id: w.txn, memo: "ok" })).isError, false);

      for (let i = 0; i < AI_DAILY_WRITE_CAP; i++) {
        execute(w.db,
          `INSERT INTO ai_access_log (token_id, token_name, member_id, tool, arguments, ok, bytes, at, connection_id, wrote)
           VALUES (?,?,?,?,?,1,0,?,?,1)`, writer.token.id, "Claude Code", PRIYA, "set_memo", "{}", nowIST(), writer.token.id);
      }
      const capped = await call(app, writer.secret, "set_memo", { transaction_id: w.txn, memo: "too many" });
      assert.equal(capped.isError, true);
      assert.match(capped.text, /100 changes today/);
      assert.equal(getTransaction(w.db, w.txn)!.memo, "ok");
      // Another connection has its own allowance.
      const other = aiToken(w.db, PRIYA, "read-write", "ChatGPT");
      assert.equal((await call(app, other.secret, "set_memo", { transaction_id: w.txn, memo: "other" })).isError, false);
    } finally { await app.close(); }
  });
});

describe("AIW · undoing, and Activity", () => {
  test("undo today reverses one connection's day, and warns before discarding later edits", async () => {
    const w = world();
    const writer = aiToken(w.db, PRIYA);
    const other = aiToken(w.db, PRIYA, "read-write", "ChatGPT");
    const app = await startTestApp(w.db, { memberId: PRIYA, config: STANDARD });
    try {
      const second = queryAll<{ id: string }>(w.db, `SELECT id FROM transactions WHERE account_id = ? ORDER BY date LIMIT 1`, w.ids.householdAccount)[0]!.id;
      await call(app, writer.secret, "set_envelope", { transaction_id: w.txn, category_id: w.dining });
      // Its own later write to the same record is undone with it, not "a later change".
      await call(app, writer.secret, "set_memo", { transaction_id: w.txn, memo: "by Claude" });
      await call(app, writer.secret, "set_memo", { transaction_id: second, memo: "also Claude" });
      await call(app, other.secret, "set_memo", { transaction_id: second, memo: "by ChatGPT" });

      const page = await (await app.get("/tokens/ai")).text();
      assert.match(page, /Can change things/);
      assert.match(page, /changes today \(\d+\)/);

      // ChatGPT changed the second one since: the group undo says so first.
      const warn = await app.post("/tokens/ai/undo-today", { connection_id: writer.token.id });
      assert.equal(warn.status, 200);
      assert.match(await warn.text(), /Undo anyway/);
      assert.equal(getTransaction(w.db, w.txn)!.memo, "by Claude", "nothing undone before the answer");

      const forced = await app.post("/tokens/ai/undo-today", { connection_id: writer.token.id, force: "1" });
      assert.equal(forced.status, 303);
      const t = getTransaction(w.db, w.txn)!;
      assert.equal(t.memo, null);
      assert.equal(t.category_id, w.ids.groceries);
      // Forced over a later edit: the record is as it was before Claude, ChatGPT's memo lost.
      assert.equal(getTransaction(w.db, second)!.memo, null);
      // ChatGPT's change is still its own, and not part of Claude's day.
      assert.equal(queryOne<{ n: number }>(w.db,
        `SELECT COUNT(*) AS n FROM events WHERE idempotency_key = ? AND undone_by_event_id IS NULL`, aiIdempotencyKey(other.token.id))!.n, 1);

      // Not somebody else's connection.
      const ravi = await startTestApp(w.db, { memberId: RAVI, config: STANDARD });
      try {
        assert.equal((await ravi.post("/tokens/ai/undo-today", { connection_id: other.token.id })).status, 404);
      } finally { await ravi.close(); }
      assert.deepEqual(app.failures, []);
    } finally { await app.close(); }
  });

  test("Activity filters to AI changes and names the app", async () => {
    const w = world();
    const writer = aiToken(w.db, PRIYA);
    const app = await startTestApp(w.db, { memberId: PRIYA, config: STANDARD });
    try {
      await call(app, writer.secret, "set_memo", { transaction_id: w.txn, memo: "ai memo" });
      const all = await (await app.get("/activity")).text();
      assert.match(all, /AI changes/);
      const ai = await (await app.get("/activity?source=ai")).text();
      assert.match(ai, /by Claude Code \(AI\)/);
      assert.doesNotMatch(ai, /Added the payee|Created the API token/);
    } finally { await app.close(); }
  });
});

describe("AIW · OAuth: allowing changes when an app signs in", () => {
  const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
  function pkce() {
    const verifier = randomBytes(32).toString("base64url");
    return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
  }
  async function connect(app: TestApp, fields: Record<string, string>) {
    const reg = await fetch(app.baseUrl + "/oauth/register", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "Claude", redirect_uris: [CALLBACK], token_endpoint_auth_method: "none" }),
    });
    const clientId = ((await reg.json()) as { client_id: string }).client_id;
    const { verifier, challenge } = pkce();
    const query = {
      client_id: clientId, redirect_uri: CALLBACK, response_type: "code", code_challenge: challenge,
      code_challenge_method: "S256", state: "s", resource: "http://127.0.0.1/mcp", scope: "read budget:write",
    };
    const consent = await (await app.get(`/oauth/authorize?${new URLSearchParams(query)}`)).text();
    const res = await app.post("/oauth/authorize", { ...query, decision: "approve", ...fields });
    assert.equal(res.status, 303, JSON.stringify(app.failures).slice(0, 2000));
    const code = new URL(res.headers.get("location")!).searchParams.get("code")!;
    const tok = await fetch(app.baseUrl + "/oauth/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: CALLBACK, client_id: clientId, code_verifier: verifier }).toString(),
    });
    return { consent, tokens: (await tok.json()) as { access_token: string; scope: string } };
  }

  test("off: no write scope is advertised or offered, and none is granted", async () => {
    const w = world();
    const app = await startTestApp(w.db, { memberId: PRIYA });
    try {
      const meta = await (await fetch(app.baseUrl + "/.well-known/oauth-authorization-server")).json() as { scopes_supported: string[] };
      assert.deepEqual(meta.scopes_supported, ["read"]);
      const { consent, tokens } = await connect(app, { allow_changes: "1" });
      assert.doesNotMatch(consent, /allow_changes/);
      assert.equal(tokens.scope, "read");
      const row = queryOne<{ scope: string; for_ai: number }>(w.db, `SELECT scope, for_ai FROM api_tokens WHERE oauth_grant_id IS NOT NULL`)!;
      assert.deepEqual([row.scope, row.for_ai], ["read", 1]);
    } finally { await app.close(); }
  });

  test("standard: an unticked box gives read; a ticked one gives a token that can write over /mcp only", async () => {
    const w = world();
    const app = await startTestApp(w.db, { memberId: PRIYA, config: STANDARD });
    try {
      const meta = await (await fetch(app.baseUrl + "/.well-known/oauth-protected-resource")).json() as { scopes_supported: string[] };
      assert.deepEqual(meta.scopes_supported, ["read", "budget:write"]);

      const plain = await connect(app, {});
      assert.match(plain.consent, /name="allow_changes" value="1">/, "offered, and not ticked");
      assert.equal(plain.tokens.scope, "read");
      assert.equal((await toolNames(app, plain.tokens.access_token)).length, 17);

      const writer = await connect(app, { allow_changes: "1" });
      assert.equal(writer.tokens.scope, "read budget:write");
      assert.equal((await toolNames(app, writer.tokens.access_token)).length, 24);
      const rest = await fetch(app.baseUrl + "/assign", {
        method: "POST",
        headers: { Authorization: `Bearer ${writer.tokens.access_token}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: "x=1",
      });
      assert.equal(rest.status, 403);
      const page = await (await app.get("/tokens/ai")).text();
      assert.match(page, /No, read-only/);
      assert.match(page, /<td>Yes<\/td>\s*<td class="faint">/);
    } finally { await app.close(); }
  });

  test("Connect an AI offers Allow changes only when AI_WRITE does, unticked", async () => {
    const w = world();
    const off = await startTestApp(w.db, { memberId: PRIYA });
    try {
      assert.doesNotMatch(await (await off.get("/tokens/ai")).text(), /allow_changes/);
      await off.post("/tokens/ai", { name: "Sneaky", allow_changes: "1", expires_in_days: "30" });
      assert.equal(queryOne<{ scope: string }>(w.db, `SELECT scope FROM api_tokens WHERE name = 'Sneaky'`)!.scope, "read");
    } finally { await off.close(); }
    const on = await startTestApp(w.db, { memberId: PRIYA, config: STANDARD });
    try {
      assert.match(await (await on.get("/tokens/ai")).text(), /name="allow_changes" value="1">/);
      await on.post("/tokens/ai", { name: "Writer", allow_changes: "1", expires_in_days: "30" });
      const row = queryOne<{ scope: string; for_ai: number }>(w.db, `SELECT scope, for_ai FROM api_tokens WHERE name = 'Writer'`)!;
      assert.deepEqual([row.scope, row.for_ai], ["read-write", 1]);
    } finally { await on.close(); }
  });
});
