/**
 * PLAN-1 · Walk a running app the way a person would, under one combination of
 * modules, and report everything that would break for them.
 *
 * The plan tests boot the app against one simulated household — three years of
 * data touching every module — under many combinations of FEATURE_* flags, and
 * run this walk under each. It is the downgrade case by construction: the data
 * for a module that is off is still in the database, and nothing may trip over
 * it.
 *
 * What counts as broken:
 *   · any page answering 500;
 *   · a page of a module that is off answering anything but 404, or a page of a
 *     module that is on answering 404;
 *   · any link, form or palette command on any page pointing at a page this
 *     configuration does not serve — a dead end in the navigation.
 *
 * Pages are visited by following links from every parameterless GET route, so a
 * page only reachable from another one is reached. Each route pattern is fetched
 * at most twice — the second instance catches a page that differs by its data —
 * which keeps one walk to a few hundred requests.
 *
 * Not a `.test.ts` file: this is the fixture the plan tests import.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pathAvailable, type Features } from "../features.ts";
import { describe, test, before } from "node:test";
import assert from "node:assert/strict";
import { freshDb, startTestApp, type TestApp } from "./harness.test-data.ts";
import { simulateHousehold } from "../sim/scenario.ts";
import { detailPages } from "./plan-seeds.test-data.ts";
import type { DB } from "../db/db.ts";
import { mintToken } from "../auth/tokens.ts";
import { TOOL_MODULES } from "../ai/tools.ts";

const here = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(join(here, "..", "app.ts"), "utf8");

/** Every `router.get("…")` path registered in app.ts. */
export function registeredGetPaths(): string[] {
  const out: string[] = [];
  const re = /router\.get\(\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(appSource)) !== null) out.push(m[1]!);
  return out;
}

/*
 * Doors a walk must not go through: they sign the walker out, start an OAuth
 * dance with a provider that is not there, or enter the demo.
 */
const SKIP = [/^\/signout/, /^\/auth\//, /^\/demo\//, /^\/assets\//, /^\/gmail\/(connect|callback)/, /^\/impersonate/];

/** Pages that 404 by other configuration — password sign-in is off in the harness. */
const CONFIG_404 = new Set(["/settings/password"]);

/** A route pattern for a concrete path: ids and months become placeholders. */
function patternOf(path: string): string {
  return path
    .split("/")
    .map((s) => (/^\d{4}-\d{2}(-\d{2})?$/.test(s) ? ":month" : /\d/.test(s) && s.length >= 6 ? ":id" : s))
    .join("/");
}

/** Internal links on a page: hrefs (GETs) and form actions (submissions). */
function linksOn(body: string): { kind: "href" | "action"; path: string }[] {
  const out: { kind: "href" | "action"; path: string }[] = [];
  const re = /\b(href|action|formaction)="(\/[^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const path = m[2]!.replace(/&amp;/g, "&").split(/[?#]/)[0]!;
    if (path.startsWith("/assets/") || path === "/manifest.webmanifest") continue;
    out.push({ kind: m[1] === "href" ? "href" : "action", path });
  }
  return out;
}

export interface CrawlReport {
  pagesFetched: number;
  problems: string[];
}

export async function crawl(
  app: TestApp, features: Features,
  /**
   * `seeds` are visited whatever their pattern's count: one of every account,
   * loan and policy, so the page that shows a deposit's terms or a card's EMI
   * plan is reached rather than whichever two accounts the links led to first.
   */
  opts: { perPattern?: number; seeds?: string[] } = {},
): Promise<CrawlReport> {
  const perPattern = opts.perPattern ?? 2;
  const problems: string[] = [];
  const seen = new Set<string>();
  const perPatternCount = new Map<string, number>();
  const seeds = new Set(opts.seeds ?? []);
  const queue: string[] = [...registeredGetPaths().filter((p) => !p.includes(":")), ...seeds];
  let pagesFetched = 0;

  while (queue.length > 0) {
    const path = queue.shift()!;
    if (seen.has(path) || SKIP.some((re) => re.test(path))) continue;
    seen.add(path);
    const pattern = patternOf(path);
    const n = perPatternCount.get(pattern) ?? 0;
    if (n >= perPattern && !seeds.has(path)) continue;
    perPatternCount.set(pattern, n + 1);

    const res = await app.get(path);
    pagesFetched++;
    const available = pathAvailable(path, features);
    const contentType = res.headers.get("content-type") ?? "";
    const body = contentType.includes("text/html") ? await res.text() : (await res.arrayBuffer(), "");

    if (res.status >= 500) {
      problems.push(`GET ${path} answered ${res.status}`);
      continue;
    }
    if (!available) {
      if (res.status !== 404) problems.push(`GET ${path} is off but answered ${res.status}`);
      continue;
    }
    // A page of a module that is on may still 404 for its own reasons (a
    // param route reached with an id from another page); only a fixed route
    // is expected to exist.
    if (res.status === 404 && !path.split("/").some((s) => /\d/.test(s)) && !CONFIG_404.has(path)) {
      problems.push(`GET ${path} is on but answered 404`);
    }
    if (res.status >= 300 && res.status < 400) {
      const to = res.headers.get("location");
      if (to && to.startsWith("/")) {
        const target = to.split(/[?#]/)[0]!;
        if (!pathAvailable(target, features)) problems.push(`GET ${path} redirects to ${target}, which is off`);
        queue.push(target);
      }
      continue;
    }

    for (const link of linksOn(body)) {
      if (!pathAvailable(link.path, features)) {
        problems.push(`${path} has ${link.kind} to ${link.path}, which is off`);
        continue;
      }
      if (link.kind === "href") queue.push(link.path);
    }
    // The palette is filtered in the browser by data-features; the names it
    // carries must be exactly the modules that are on.
    const declared = /data-features="([^"]*)"/.exec(body)?.[1];
    // A bare page (sign-in, the legal pages, first-run setup) has no
    // navigation and no palette, and declares nothing.
    if (declared !== undefined && declared !== "" && res.status === 200) {
      const names = new Set(declared.split(" ").filter(Boolean));
      for (const [name, on] of Object.entries(features)) {
        if (on !== names.has(name)) problems.push(`${path}: data-features ${on ? "lacks" : "has"} ${name}`);
      }
    }
  }

  return { pagesFetched, problems: [...new Set(problems)] };
}

/**
 * PLAN-1 · The MCP endpoint under the same configuration: offered exactly when
 * FEATURE_AI is on, listing exactly the tools whose modules are on, and every
 * listed tool answering without a fault. A tool's own refusal of missing
 * arguments is an answer, not a fault; a 500 is.
 */
export async function checkMcp(app: TestApp, db: DB, memberId: string, features: Features): Promise<string[]> {
  const problems: string[] = [];
  const { secret } = mintToken(db, { memberId, source: "ui" }, { name: "plan-crawl", scope: "read" });
  const rpc = async (method: string, params: Record<string, unknown> = {}) => {
    const MODERN = "2026-07-28";
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": MODERN,
      "Mcp-Method": method,
      Authorization: `Bearer ${secret}`,
    };
    if (typeof params.name === "string") headers["Mcp-Name"] = params.name;
    const res = await fetch(app.baseUrl + "/mcp", {
      method: "POST", headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": MODERN } } }),
    });
    const text = await res.text();
    let body: { result?: any; error?: any } | null = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* not JSON: reported below by status */ }
    return { status: res.status, body };
  };

  const list = await rpc("tools/list");
  if (!features.ai) {
    if (list.status !== 404) problems.push(`/mcp is off but answered ${list.status}`);
    return problems;
  }
  if (list.status !== 200) {
    problems.push(`/mcp tools/list answered ${list.status}`);
    return problems;
  }
  const names: string[] = (list.body?.result?.tools ?? []).map((t: { name: string }) => t.name);
  for (const [tool, module] of Object.entries(TOOL_MODULES)) {
    if (features[module] !== names.includes(tool)) {
      problems.push(`/mcp ${features[module] ? "lacks" : "offers"} ${tool} with ${module} ${features[module] ? "on" : "off"}`);
    }
  }
  for (const name of names) {
    const call = await rpc("tools/call", { name, arguments: {} });
    if (call.status >= 500) problems.push(`/mcp ${name} answered ${call.status}`);
  }
  return problems;
}

/**
 * PLAN-1 · Run the walk and the MCP check under each named configuration, as
 * one `node:test` case each, against one simulated household built once.
 */
export function planSuite(title: string, configs: [string, Features][]): void {
  describe(title, () => {
    let db: DB;
    let memberId: string;
    let seeds: string[];
    before(() => {
      db = freshDb();
      memberId = simulateHousehold(db).members.ravi.id;
      seeds = detailPages(db);
    });

    for (const [name, features] of configs) {
      test(name, async () => {
        // Google configured, as a hosted instance has it for sign-in: the Gmail
        // panel only draws with it, so without it FEATURE_GMAIL went untested.
        const app = await startTestApp(db, {
          memberId, config: { features, google: { clientId: "test-client", clientSecret: "test-secret" } },
        });
        try {
          const report = await crawl(app, features, { seeds });
          // A guard on the guard: a walk that reached nothing proves nothing.
          assert.ok(report.pagesFetched > 40, `walked only ${report.pagesFetched} pages`);
          const problems = [...report.problems, ...(await checkMcp(app, db, memberId, features))];
          assert.deepEqual(problems, [], `${name}:\n${problems.join("\n")}`);
          assert.deepEqual(app.failures.map((f) => `${f.method} ${f.path}: ${f.error.split("\n")[0]}`), [], "nothing 500ed");
        } finally {
          await app.close();
        }
      });
    }
  });
}
