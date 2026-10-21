/*
 * Route sweep driver (routes area). Run from the worktree root:
 *   node --experimental-strip-types --no-warnings .scratch/route-driver.ts [phase] > .scratch/out-<phase>.txt
 * phases: get (crawl every GET as every member), post (submit every discovered form
 * as rendered + fuzzed), json (JSON/bearer), all.
 * Writes findings as JSON lines to .scratch/findings-<phase>.jsonl.
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync, appendFileSync, rmSync } from "node:fs";
import { openDatabase, ensureHousehold, queryAll, type DB } from "../src/db/db.ts";
import { simulateHousehold } from "../src/sim/scenario.ts";
import { startTestApp, testConfig, type TestApp } from "../src/web/harness.test-data.ts";
import { buildApp } from "../src/app.ts";
import type { Config } from "../src/config.ts";

const PHASE = process.argv[2] ?? "get";
const LIMIT_PAGES = Number(process.argv[3] ?? 2500);
const BASE = ".scratch/base.sqlite";
const FIND = `.scratch/findings-${PHASE}.jsonl`;
rmSync(FIND, { force: true });

const rejections: string[] = [];
process.on("unhandledRejection", (e) => { rejections.push(String((e as Error)?.stack ?? e)); finding("unhandled-rejection", "-", "-", 0, String(e)); });
process.on("uncaughtException", (e) => { rejections.push(String(e?.stack ?? e)); finding("uncaught-exception", "-", "-", 0, String(e)); });

let requests = 0;
const seenFind = new Set<string>();
function finding(kind: string, method: string, path: string, status: number, detail: string, member = "") {
  const key = `${kind}|${method}|${normalise(path)}|${detail.slice(0, 80)}`;
  if (seenFind.has(key)) return;
  seenFind.add(key);
  appendFileSync(FIND, JSON.stringify({ kind, method, path, status, member, detail: detail.slice(0, 1500) }) + "\n");
}
function normalise(p: string): string {
  return p.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, ":uuid").replace(/\?.*$/, "");
}

// ---------------------------------------------------------------- database
let sim: any;
function buildBase() {
  if (existsSync(BASE) && existsSync(BASE + ".json")) {
    sim = JSON.parse(readFileSync(BASE + ".json", "utf8"));
    return;
  }
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  const r = simulateHousehold(db);
  sim = { members: r.members, budgets: r.budgets, accounts: r.accounts, months: r.months };
  writeFileSync(BASE, (db as any).serialize());
  writeFileSync(BASE + ".json", JSON.stringify(sim));
}
let dbn = 0;
function freshCopy(): DB {
  const p = `.scratch/db-${process.pid}-${dbn++}.sqlite`;
  copyFileSync(BASE, p);
  for (const s of ["-wal", "-shm"]) rmSync(p + s, { force: true });
  return openDatabase({ path: p, verbose: false });
}

// ---------------------------------------------------------------- routes
const src = readFileSync("src/app.ts", "utf8");
const ROUTES = [...new Set([...src.matchAll(/router\.(get|post)\("([^"]+)"/g)].map((m) => `${m[1]!.toUpperCase()} ${m[2]}`))];
const probeRouter = buildApp({ db: freshCopyLazy(), config: testConfig() }).router;
function freshCopyLazy(): DB { const d = openDatabase({ path: ":memory:", verbose: false }); ensureHousehold(d); return d; }
function routeOf(method: string, path: string): string | null {
  const u = new URL(path, "http://x");
  const m = probeRouter.match(method, u.pathname);
  if (!m) return null;
  for (const r of ROUTES) {
    const [rm, rp] = r.split(" ");
    if (rm !== method) continue;
    const segs = rp!.split("/").filter(Boolean), act = u.pathname.split("/").filter(Boolean);
    if (segs.length === act.length && segs.every((s, i) => s.startsWith(":") || s === act[i])) return r;
  }
  return `${method} ?`;
}
const STATIC = /^\/(assets\/|manifest\.webmanifest|sw\.js|favicon)/;

// ---------------------------------------------------------------- ids
function ids(db: DB) {
  const col = (sql: string) => queryAll<any>(db, sql).map((r) => String(Object.values(r)[0]));
  return {
    account: col("select id from accounts"),
    loanAcct: col("select id from loans"),
    family: col("select id from family_loans"),
    holding: col("select id from holdings"),
    instrument: col("select id from instruments"),
    goal: col("select id from goals"),
    rule: col("select id from rules"),
    schedule: col("select id from schedules"),
    attachment: col("select id from attachments"),
    profile: col("select id from import_profiles"),
    token: col("select id from api_tokens"),
    tx: col("select id from transactions order by random() limit 25"),
    event: col("select id from events order by seq desc limit 30"),
    category: col("select id from categories"),
    group: col("select id from category_groups"),
    member: col("select id from members"),
    card: col("select id from cards"),
  };
}
const BOGUS = ["11111111-2222-3333-4444-555555555555", "x", "%ZZ", "..", "0", "-1", "%3Cb%3Ex%3C%2Fb%3E", "a".repeat(300)];
const MONTHS = ["2026-10", "2026-09", "2024-01", "2026-13", "1900-01", "9999-12", "abc", "2026-1"];

function paramPool(route: string, name: string, I: ReturnType<typeof ids>): string[] {
  const p = route;
  let real: string[] = [];
  if (name === "month") return MONTHS;
  if (name === "cardId") real = I.card;
  else if (p.startsWith("/accounts/")) real = I.account;
  else if (p.startsWith("/loans/")) real = [...I.loanAcct, ...I.account.slice(0, 3)];
  else if (p.startsWith("/family/")) real = I.family;
  else if (p.startsWith("/portfolio/instrument")) real = I.instrument;
  else if (p.startsWith("/portfolio/asset")) real = [...I.holding, ...I.account];
  else if (p.startsWith("/portfolio/")) real = [...I.holding, ...I.instrument];
  else if (p.startsWith("/goals/")) real = I.goal;
  else if (p.startsWith("/rules/")) real = I.rule.slice(0, 6);
  else if (p.startsWith("/schedules/")) real = I.schedule;
  else if (p.startsWith("/attachment/")) real = I.attachment;
  else if (p.startsWith("/import/profiles")) real = I.profile;
  else if (p.startsWith("/tokens/")) real = I.token;
  else if (p.startsWith("/transaction/")) real = I.tx.slice(0, 12);
  else if (p.startsWith("/activity/")) real = I.event.slice(0, 10);
  else if (p.startsWith("/explain/category") || p.startsWith("/categories/")) real = I.category;
  else if (p.startsWith("/groups/")) real = I.group;
  else if (p.startsWith("/members/")) real = I.member;
  return [...real, ...BOGUS];
}
function fills(route: string, I: ReturnType<typeof ids>): string[] {
  const names = [...route.matchAll(/:(\w+)/g)].map((m) => m[1]!);
  if (names.length === 0) return [route];
  let out = [route];
  for (const n of names) {
    const pool = paramPool(route, n, I);
    const next: string[] = [];
    for (const o of out) for (const v of pool) next.push(o.replace(`:${n}`, v));
    out = next.slice(0, 120);
  }
  return out;
}

// ---------------------------------------------------------------- html checks
const BAD = /(^|[^\w-])(undefined|NaN|Infinity|null|\[object Object\])([^\w-]|$)/;
function checkHtml(body: string, method: string, path: string, status: number, member: string, allow: string[] = []) {
  const clean = body.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
  const ok = (s: string) => allow.some((a) => a && s.includes(a));
  for (const m of clean.matchAll(/>([^<]+)</g)) {
    const t = m[1]!;
    const b = BAD.exec(t);
    if (b && !ok(t)) finding("bad-text", method, path, status, `${b[2]} in text: …${t.trim().slice(0, 160)}…`, member);
  }
  for (const m of clean.matchAll(/\s([\w:-]+)="([^"]*)"/g)) {
    const b = BAD.exec(m[2]!);
    if (b && !ok(m[2]!) && !/^(content|d|points|pattern)$/.test(m[1]!)) finding("bad-attr", method, path, status, `${m[1]}="${m[2]!.slice(0, 160)}"`, member);
  }
  if (/<x-fuzz/i.test(body)) finding("unescaped-markup", method, path, status, "fuzz markup echoed raw", member);
}

function links(body: string): { href: string[]; forms: Form[] } {
  const clean = body.replace(/<script[\s\S]*?<\/script>/gi, "");
  const href = [...clean.matchAll(/\shref="([^"]*)"/g)].map((m) => decodeEnt(m[1]!));
  const forms: Form[] = [];
  for (const m of clean.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) forms.push(parseForm(m[1]!, m[2]!));
  // forms that are never closed / nested: also capture formaction buttons
  for (const m of clean.matchAll(/\sformaction="([^"]*)"/g)) forms.push({ method: "post", action: decodeEnt(m[1]!), enctype: "", fields: [] });
  return { href, forms };
}
type Field = { name: string; value: string; type: string; options?: string[] };
type Form = { method: string; action: string; enctype: string; fields: Field[] };
function attr(s: string, a: string): string | null {
  const m = new RegExp(`\\s${a}="([^"]*)"`, "i").exec(s) ?? new RegExp(`\\s${a}=([^\\s>]+)`, "i").exec(s);
  return m ? decodeEnt(m[1]!) : (new RegExp(`\\s${a}(\\s|$|>)`, "i").test(s) ? "" : null);
}
function decodeEnt(s: string) { return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'"); }
function parseForm(open: string, inner: string): Form {
  const fields: Field[] = [];
  const radios = new Set<string>();
  for (const m of inner.matchAll(/<input\b([^>]*)>/gi)) {
    const a = m[1]!; const name = attr(a, "name"); if (!name) continue;
    const type = (attr(a, "type") ?? "text").toLowerCase();
    if (type === "submit" || type === "button" || type === "image" || type === "reset") continue;
    if ((type === "checkbox" || type === "radio") && attr(a, "checked") === null) { if (type === "radio") radios.add(name); continue; }
    fields.push({ name, value: attr(a, "value") ?? (type === "checkbox" ? "on" : ""), type });
  }
  for (const m of inner.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
    const name = attr(m[1]!, "name"); if (!name) continue;
    const opts = [...m[2]!.matchAll(/<option\b([^>]*)>([^<]*)/gi)].map((o) => ({ v: attr(o[1]!, "value") ?? o[2]!.trim(), sel: attr(o[1]!, "selected") !== null }));
    const sel = opts.find((o) => o.sel) ?? opts[0];
    fields.push({ name, value: sel?.v ?? "", type: "select", options: opts.map((o) => o.v) });
  }
  for (const m of inner.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi)) {
    const name = attr(m[1]!, "name"); if (name) fields.push({ name, value: decodeEnt(m[2]!), type: "textarea" });
  }
  // radios with nothing checked: take the first
  for (const r of radios) if (!fields.some((f) => f.name === r)) {
    const m = new RegExp(`<input[^>]*name="${r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>`, "i").exec(inner);
    if (m) fields.push({ name: r, value: attr(m[0], "value") ?? "", type: "radio" });
  }
  const btn = /<button\b([^>]*)>/i.exec(inner);
  if (btn) { const n = attr(btn[1]!, "name"); if (n) fields.push({ name: n, value: attr(btn[1]!, "value") ?? "", type: "button" }); }
  return { method: (attr(open, "method") ?? "get").toLowerCase(), action: attr(open, "action") ?? "", enctype: attr(open, "enctype") ?? "", fields };
}

// ---------------------------------------------------------------- requests
async function timed(app: TestApp, method: string, path: string, init: RequestInit, member: string, fuzzAllow: string[] = []): Promise<{ status: number; body: string; loc: string | null; ct: string }> {
  requests++;
  const t = Date.now();
  let res: Response;
  try {
    res = await fetch(app.baseUrl + path, { ...init, method, redirect: "manual", signal: AbortSignal.timeout(15000) });
  } catch (e) {
    finding("hang-or-error", method, path, 0, String(e), member);
    return { status: 0, body: "", loc: null, ct: "" };
  }
  const body = await res.text();
  const ms = Date.now() - t;
  if (ms > 2000) finding("slow", method, path, res.status, `${ms} ms`, member);
  if (res.status >= 500) {
    const f = app.failures.at(-1);
    finding("500", method, path, res.status, f ? f.error.split("\n").slice(0, 4).join(" | ") : body.slice(0, 200), member);
  }
  const loc = res.headers.get("location");
  const ct = res.headers.get("content-type") ?? "";
  if (loc) {
    const u = new URL(loc, app.baseUrl);
    if (u.origin === app.baseUrl && !STATIC.test(u.pathname) && !routeOf("GET", u.pathname + u.search)) finding("redirect-to-missing", method, path, res.status, `-> ${loc}`, member);
  }
  if (ct.includes("text/html")) checkHtml(body, method, path, res.status, member, fuzzAllow);
  if (ct.includes("json")) { try { const j = JSON.parse(body); if (j && typeof j.redirect === "string") { const u = new URL(j.redirect, app.baseUrl); if (u.origin === app.baseUrl && !routeOf("GET", u.pathname)) finding("json-redirect-to-missing", method, path, res.status, `-> ${j.redirect}`, member); } } catch { finding("bad-json", method, path, res.status, body.slice(0, 200), member); } if (/\bNaN\b|"undefined"|\[object Object\]/.test(body) && !fuzzAllow.some((a) => body.includes(a))) finding("bad-json-value", method, path, res.status, body.slice(0, 300), member); }
  if (ct.includes("csv") && /(^|,)(undefined|NaN|null|\[object Object\]|Infinity)(,|$)/m.test(body)) finding("bad-csv", method, path, res.status, (/.*(undefined|NaN|null|\[object Object\]|Infinity).*/m.exec(body) ?? [""])[0].slice(0, 200), member);
  return { status: res.status, body, loc, ct };
}

function cookieOf(app: TestApp): Promise<string> { return Promise.resolve(""); }

// session cookie: harness keeps it private; re-mint here.
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.ts";
async function boot(db: DB, memberId: string | null, config: Partial<Config> = {}) {
  const app = await startTestApp(db, { memberId: null, config });
  const cookie = memberId ? `${SESSION_COOKIE}=${createSession(db, memberId, { userAgent: "drv", ipHint: null, days: 30 }).token}` : "";
  return { app, cookie };
}

// ---------------------------------------------------------------- phase GET
const formsSeen = new Map<string, { member: string; form: Form; page: string }[]>();
async function crawl(memberKey: string, memberId: string | null, config: Partial<Config> = {}, label = memberKey) {
  const db = freshCopy();
  const I = ids(db);
  const { app, cookie } = await boot(db, memberId, config);
  const H = { headers: cookie ? { Cookie: cookie } : {} };
  const queue: string[] = [];
  const seen = new Set<string>();
  const perPattern = new Map<string, number>();
  const push = (p: string, from: string) => {
    if (!p || p.startsWith("#") || /^(mailto:|tel:|javascript:|data:)/.test(p)) return;
    let u: URL;
    try { u = new URL(p, app.baseUrl + from); } catch { finding("bad-href", "GET", from, 0, p, label); return; }
    if (u.origin !== app.baseUrl) return;
    if (STATIC.test(u.pathname)) return;
    const path = u.pathname + u.search;
    if (!routeOf("GET", path)) { finding("link-to-missing", "GET", from, 0, `href ${p}`, label); return; }
    const key = normalise(u.pathname) + "?" + [...u.searchParams.keys()].sort().join("&");
    const n = perPattern.get(key) ?? 0;
    if (n >= 6 || seen.has(path)) return;
    perPattern.set(key, n + 1);
    seen.add(path); queue.push(path);
  };
  for (const r of ROUTES) { const [m, p] = r.split(" "); if (m !== "GET") continue; if (/^\/(auth|gmail)\//.test(p!)) continue; for (const f of fills(p!, I)) { seen.add(f); queue.push(f); } }
  // query fuzz on a few routes that read the query
  for (const p of ["/", "/accounts", "/reports", "/query", "/search", "/schedules", "/overview", "/net-worth", "/fire", "/tax", "/activity", "/review", "/payees", "/categories", "/months", "/portfolio", "/goals", "/cards", "/household", "/move", "/hold", "/auto-assign", "/add", "/transfer", "/query.csv", "/export.csv", "/net-worth.csv", "/loans/what-if", "/explain/ready-to-assign"]) {
    for (const q of ["month=2026-13", "month=abc", "month=1900-01", "month=9999-12", "from=2026-02-30&to=x", "from=2030-01-01&to=2020-01-01", "days=-1", "q=%3Cx-fuzz%3E", "page=-1", "page=abc", "page=99999", "account=nope", "category=nope", "budget=nope", "range=nope", "group=nope", "sort=nope", "year=abc", "fy=abc", "fy=1900", "amount=1e400", "member=nope", "scope=nope", "view=nope", "tab=nope", "kind=nope", "limit=-5", "limit=99999999", "month=2026-10&month=2026-09"]) {
      const path = `${p}?${q}`; if (!seen.has(path)) { seen.add(path); queue.push(path); }
    }
  }
  let pages = 0;
  while (queue.length && pages < LIMIT_PAGES) {
    const path = queue.shift()!;
    pages++;
    const r = await timed(app, "GET", path, H, label, ["x-fuzz", "nope", "abc"]);
    if (r.status === 404 && !/\/(x|%ZZ|\.\.|0|-1|%3Cb%3Ex%3C%2Fb%3E|a{300}|11111111-2222-3333-4444-555555555555)(\/|$|\.)|2026-13|abc|1900-01|9999-12|2026-1(\/|$)|x-fuzz|nope|\/settings\/password/.test(path)) finding("404-on-real", "GET", path, 404, "", label);
    if (!r.ct.includes("text/html")) continue;
    const { href, forms } = links(r.body);
    for (const h of href) push(h, path);
    for (const f of forms) {
      let u: URL; try { u = new URL(f.action || path, app.baseUrl + path); } catch { finding("bad-action", "GET", path, 0, f.action, label); continue; }
      if (u.origin !== app.baseUrl) continue;
      const m = f.method === "post" ? "POST" : "GET";
      if (!routeOf(m, u.pathname)) { finding("form-to-missing", m, path, 0, `action ${f.action}`, label); continue; }
      if (m === "GET") { const q = new URLSearchParams(f.fields.map((x) => [x.name, x.value])); push(u.pathname + "?" + q, path); continue; }
      const key = `${memberKey}|${routeOf("POST", u.pathname)}`;
      const list = formsSeen.get(key) ?? [];
      const sig = JSON.stringify(f.fields.map((x) => x.name));
      if (list.length < 4 && !list.some((l) => JSON.stringify(l.form.fields.map((x) => x.name)) === sig && l.form.action === f.action)) {
        list.push({ member: memberKey, form: { ...f, action: u.pathname + u.search }, page: path });
        formsSeen.set(key, list);
      }
    }
  }
  console.log(`[${label}] crawled ${pages} pages, queue left ${queue.length}, failures ${app.failures.length}`);
  await app.close();
  return pages;
}

// ---------------------------------------------------------------- phase POST
const FUZZ = ["", "0", "-1", "-0", "0.001", "1.005", "1e400", "99999999999999999999", "abc", "<x-fuzz>'\"", "2026-02-30", "9999-12-31", "0001-01-01", "NaN", "Infinity", " ", "x".repeat(5000), "%00", "₹1,00,000", "null", "undefined", "2026-13", "11111111-2222-3333-4444-555555555555"];
function encodeMultipart(fields: [string, string][]): { body: Buffer; type: string } {
  const b = "----drv" + Math.random().toString(16).slice(2);
  const parts: Buffer[] = [];
  for (const [k, v] of fields) {
    if (k === "file" || k === "pdf" || k === "attachment" || k === "receipt") {
      parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"; filename="x.csv"\r\nContent-Type: text/csv\r\n\r\n${v || "Date,Amount\n01-01-2026,100"}\r\n`));
    } else parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(Buffer.from(`--${b}--\r\n`));
  return { body: Buffer.concat(parts), type: `multipart/form-data; boundary=${b}` };
}
async function postForm(app: TestApp, cookie: string, form: Form, fields: [string, string][], label: string, allow: string[], json = false) {
  const headers: Record<string, string> = { Origin: app.baseUrl };
  if (cookie) headers.Cookie = cookie;
  let body: BodyInit;
  if (json) {
    headers["Content-Type"] = "application/json"; headers.Accept = "application/json";
    body = JSON.stringify(Object.fromEntries(fields));
  } else if (form.enctype.includes("multipart")) {
    const mp = encodeMultipart(fields); headers["Content-Type"] = mp.type; body = mp.body;
  } else {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(fields).toString();
  }
  return timed(app, "POST", form.action, { headers, body }, label, allow);
}
const SKIP_POST = /^\/(auth\/|gmail\/|signout|health\/backup|sessions\/revoke|demo\/enter|impersonate)/;
async function postPhase(fuzz: boolean) {
  const entries = [...formsSeen.entries()];
  console.log(`forms to post: ${entries.length} patterns`);
  let batch = 0;
  for (const [key, list] of entries) {
    const [memberKey] = key.split("|");
    const memberId = memberKey === "anon" ? null : sim.members[memberKey!]?.id;
    for (const { form, page } of list) {
      if (SKIP_POST.test(form.action)) continue;
      const db = freshCopy(); batch++;
      const { app, cookie } = await boot(db, memberId);
      const base: [string, string][] = form.fields.map((f) => [f.name, f.value]);
      const r = await postForm(app, cookie, form, base, memberKey!, []);
      if (r.status === 404 && !form.action.includes("1111")) finding("404-on-rendered-form", "POST", form.action, 404, `from ${page}: ${r.body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 200)}`, memberKey);
      if (r.status === 400 || r.status === 422) finding("rendered-form-refused", "POST", form.action, r.status, `from ${page} fields ${JSON.stringify(base).slice(0, 300)} :: ${r.body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 300)}`, memberKey);
      if (fuzz && list.indexOf(list.find((l) => l.form === form)!) === 0) {
        // fuzz each field on a db where the rendered submission may have changed state: use a second copy
        const db2 = freshCopy();
        const b2 = await boot(db2, memberId);
        await postForm(b2.app, b2.cookie, form, [], memberKey!, []);
        for (let i = 0; i < base.length; i++) {
          for (const v of FUZZ) {
            const fs = base.map((x, j) => (j === i ? [x[0], v] : x)) as [string, string][];
            await postForm(b2.app, b2.cookie, form, fs, memberKey!, [v, "x-fuzz", "undefined", "null", "NaN", "Infinity"]);
          }
          // duplicated field
          await postForm(b2.app, b2.cookie, form, [...base, [base[i]![0], "abc"]], memberKey!, ["abc"]);
        }
        // JSON body with odd types
        await postForm(b2.app, b2.cookie, form, base, memberKey!, [], true);
        const odd = { ...Object.fromEntries(base) } as any;
        for (const k of Object.keys(odd)) odd[k] = [1, 2];
        await timed(b2.app, "POST", form.action, { headers: { Origin: b2.app.baseUrl, Cookie: b2.cookie, "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(odd) }, memberKey!, []);
        for (const k of Object.keys(odd)) odd[k] = { a: 1 };
        await timed(b2.app, "POST", form.action, { headers: { Origin: b2.app.baseUrl, Cookie: b2.cookie, "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(odd) }, memberKey!, []);
        for (const k of Object.keys(odd)) odd[k] = 1e308;
        await timed(b2.app, "POST", form.action, { headers: { Origin: b2.app.baseUrl, Cookie: b2.cookie, "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(odd) }, memberKey!, []);
        await b2.app.close(); b2.app.db.close?.();
      }
      await app.close(); app.db.close?.();
    }
    if (batch % 20 === 0) console.log(`  posted ${batch} forms, requests ${requests}`);
  }
  // Every POST route not reached by a form: empty and bogus bodies, all members.
  const reached = new Set([...formsSeen.keys()].map((k) => k.split("|")[1]));
  const unreached = ROUTES.filter((r) => r.startsWith("POST") && !reached.has(r));
  console.log(`POST routes with no rendered form: ${unreached.length}: ${unreached.join(", ")}`);
  for (const mk of ["ravi", "priya", "anil"]) {
    const db = freshCopy(); const I = ids(db);
    const { app, cookie } = await boot(db, sim.members[mk].id);
    for (const r of unreached) {
      const p = r.slice(5); if (SKIP_POST.test(p)) continue;
      for (const f of fills(p, I).slice(0, 12)) for (const body of [{}, { amount: "abc", date: "x", month: "2026-13", name: "<x-fuzz>" }]) {
        await postForm(app, cookie, { method: "post", action: f, enctype: "", fields: [] }, Object.entries(body), mk, ["x-fuzz"]);
      }
    }
    await app.close();
  }
}

// ---------------------------------------------------------------- query fuzz
function queryKeysByRoute(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const re = /router\.(get|post)\("([^"]+)"/g;
  const hits = [...src.matchAll(re)];
  const helpers: Record<string, string[]> = {
    noticeFrom: ["notice", "kind"], holderScopeParam: ["whose"], budgetParam: ["budget"], currentBudget: ["budget"],
    monthParam: ["month"], filterFromQuery: ["period", "account", "category", "scope", "q", "from", "to"],
    queryPage: ["group_by", "q", "period", "account", "category", "scope", "from", "to"], taxPageProps: ["fy"],
  };
  for (let i = 0; i < hits.length; i++) {
    if (hits[i]![1] !== "get") continue;
    const body = src.slice(hits[i]!.index!, hits[i + 1]?.index ?? src.length);
    const keys = new Set<string>(["notice", "kind", "budget", "month"]);
    for (const m of body.matchAll(/query\.get\("([a-z_]+)"\)/g)) keys.add(m[1]!);
    for (const m of body.matchAll(/rupeesFromQuery\(ctx, "([a-z_]+)"/g)) keys.add(m[1]!);
    for (const [h, ks] of Object.entries(helpers)) if (body.includes(h + "(")) ks.forEach((k) => keys.add(k));
    out.set(hits[i]![2]!, [...keys]);
  }
  return out;
}
const QFUZZ = ["<x-fuzz>", "-1", "1e400", "abc", "", "0", "99999999999", "2026-02-30"];
async function queryFuzz(memberKey: string) {
  const db = freshCopy(); const I = ids(db);
  const { app, cookie } = await boot(db, sim.members[memberKey].id);
  const H = { headers: { Cookie: cookie } };
  const keys = queryKeysByRoute();
  let n = 0;
  for (const [route, ks] of keys) {
    if (/^\/(auth|gmail)\//.test(route)) continue;
    const path = fills(route, I)[0]!;
    for (const k of ks) for (const v of QFUZZ) {
      n++;
      await timed(app, "GET", `${path}?${k}=${encodeURIComponent(v)}`, H, `${memberKey}-qfuzz`, [v, "x-fuzz", "abc"]);
    }
  }
  console.log(`[${memberKey}] query fuzz ${n} requests`);
  await app.close();
}

// ---------------------------------------------------------------- main
buildBase();
console.log(`routes: ${ROUTES.length}`);
const t0 = Date.now();
const members: [string, string | null][] = [["ravi", sim.members.ravi.id], ["priya", sim.members.priya.id], ["anil", sim.members.anil.id], ["meera", sim.members.meera.id], ["anon", null]];
if (PHASE === "post" && existsSync(".scratch/forms.json")) {
  for (const [k, v] of JSON.parse(readFileSync(".scratch/forms.json", "utf8"))) formsSeen.set(k, v);
} else if (PHASE === "get" || PHASE === "post" || PHASE === "all") {
  for (const [k, id] of members) await crawl(k, id);
  if (PHASE !== "post") {
    await crawl("ravi", sim.members.ravi.id, { features: { loans: false, assets: false, multiCurrency: false } }, "ravi-nofeatures");
    await crawl("ravi", sim.members.ravi.id, { demoMode: true }, "ravi-demo");
    await crawl("ravi", sim.members.ravi.id, { adminDebug: true }, "ravi-admindebug");
  }
  writeFileSync(".scratch/forms.json", JSON.stringify([...formsSeen.entries()]));
}
if (PHASE === "misc") {
  const { mintToken } = await import("../src/auth/tokens.ts");
  for (const cfg of [{}, { localLogin: true }, { devLogin: true }, { demoMode: true }, { adminDebug: true }, { google: { clientId: "c", clientSecret: "s" }, oidc: { issuer: "https://idp.invalid", clientId: "c", clientSecret: "s", label: "SSO" } }] as Partial<Config>[]) {
    for (const who of [null, sim.members.ravi.id, sim.members.anil.id]) {
      const db = freshCopy(); const I = ids(db);
      const { app, cookie } = await boot(db, who, cfg);
      const label = `${who ? "m" : "anon"}-${JSON.stringify(cfg).slice(0, 30)}`;
      const H: Record<string, string> = cookie ? { Cookie: cookie } : {};
      for (const r of ROUTES) {
        const [m, p] = r.split(" ") as [string, string];
        if (!/^\/(auth|gmail|signout|sessions|demo|impersonate|health|settings\/password|signin)/.test(p)) continue;
        for (const path of fills(p, I).slice(0, 4)) {
          if (m === "GET") {
            for (const q of ["", "?code=x&state=y", "?state=%3Cx-fuzz%3E&next=//evil.example", "?error=access_denied", "?next=https://evil.example"]) await timed(app, "GET", path + q, { headers: H }, label, ["x-fuzz"]);
          } else {
            for (const body of [{}, { email: "<x-fuzz>@x", password: "x", member_id: I.member[0]!, next: "//evil.example", name: "<x-fuzz>", token: "x" }, { member_id: "nope", email: "a".repeat(5000), password: "" }]) {
              const res = await timed(app, "POST", path, { headers: { ...H, Origin: app.baseUrl, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body as any).toString() }, label, ["x-fuzz"]);
              if (res.loc && /evil\.example/.test(res.loc)) finding("open-redirect", "POST", path, res.status, res.loc, label);
            }
          }
        }
      }
      await app.close();
    }
  }
  // bearer tokens, JSON accept, every route
  for (const scope of ["read", "read-write"] as const) {
    const db = freshCopy(); const I = ids(db);
    const minted = mintToken(db, { memberId: sim.members.ravi.id, source: "ui" } as any, { name: "drv", scope, expiresInDays: null });
    const { app } = await boot(db, null);
    const H = { Authorization: `Bearer ${minted.secret}`, Accept: "application/json" };
    for (const r of ROUTES) {
      const [m, p] = r.split(" ") as [string, string];
      if (/^\/(auth|gmail|demo)\//.test(p) || /signout|restore|health\/backup/.test(p)) continue;
      for (const path of fills(p, I).slice(0, 3)) {
        if (m === "GET") await timed(app, "GET", path, { headers: H }, `bearer-${scope}`);
        else for (const body of [{}, { amount: "abc", month: "2026-13", name: "x" }]) await timed(app, "POST", path, { headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify(body) }, `bearer-${scope}`);
      }
    }
    await app.close();
  }
}
if (PHASE === "qfuzz") { await queryFuzz("ravi"); await queryFuzz("anil"); }
if (PHASE === "post" || PHASE === "all") await postPhase(true);
console.log(`DONE phase=${PHASE} requests=${requests} secs=${Math.round((Date.now() - t0) / 1000)} rejections=${rejections.length}`);
process.exit(0);
