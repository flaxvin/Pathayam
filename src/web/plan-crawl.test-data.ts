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
import type { TestApp } from "./harness.test-data.ts";

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

export async function crawl(app: TestApp, features: Features, opts: { perPattern?: number } = {}): Promise<CrawlReport> {
  const perPattern = opts.perPattern ?? 2;
  const problems: string[] = [];
  const seen = new Set<string>();
  const perPatternCount = new Map<string, number>();
  const queue: string[] = registeredGetPaths().filter((p) => !p.includes(":"));
  let pagesFetched = 0;

  while (queue.length > 0) {
    const path = queue.shift()!;
    if (seen.has(path) || SKIP.some((re) => re.test(path))) continue;
    seen.add(path);
    const pattern = patternOf(path);
    const n = perPatternCount.get(pattern) ?? 0;
    if (n >= perPattern) continue;
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
    if (declared !== undefined && res.status === 200) {
      const names = new Set(declared.split(" ").filter(Boolean));
      for (const [name, on] of Object.entries(features)) {
        if (on !== names.has(name)) problems.push(`${path}: data-features ${on ? "lacks" : "has"} ${name}`);
      }
    }
  }

  return { pagesFetched, problems: [...new Set(problems)] };
}
