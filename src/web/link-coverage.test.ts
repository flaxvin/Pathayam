/**
 * B51 · Every internal link points at a route that exists.
 *
 * Five separate features shipped complete on the server yet were unreachable
 * from the client — a "Record a transfer" link to a route with no GET, a
 * "Manage cards" button to a path nobody registered, an "Export CSV" link that
 * a param route shadowed. The tests never saw it because they exercise
 * handlers, not the wiring between a rendered link and its handler.
 *
 * This closes that seam the way `ops/coverage.test.ts` closed the backup one:
 * a set that must stay in step (the links the UI renders and the routes the
 * app serves) is now forced to, statically. It parses the `href`/`action`
 * attributes out of every page and the `router.get/post(...)` registrations
 * out of `app.ts`, then checks each internal link resolves — an `href` to a
 * GET, a form `action` to a POST — under the same most-specific-segment
 * matching the live router uses.
 *
 * Interpolations (`/loans/${loan.id}/pay`) become a wildcard segment that a
 * `:param` — or a literal — satisfies. A link built entirely from a variable
 * cannot be checked and is skipped; the goal is to catch the static dead link,
 * which is the one that ships.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readdirSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(join(here, "..", "app.ts"), "utf8");

interface Route {
  method: "GET" | "POST";
  segments: string[];
}

/** Pull `router.get("…")` / `router.post("…")` out of app.ts. */
function registeredRoutes(): Route[] {
  const routes: Route[] = [];
  const re = /router\.(get|post)\(\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(appSource)) !== null) {
    routes.push({ method: m[1]!.toUpperCase() as "GET" | "POST", segments: split(m[2]!) });
  }
  return routes;
}

/** The static-asset prefix guard in app.ts short-circuits before the router. */
const STATIC_PREFIX = "/assets/";

function split(path: string): string[] {
  return path.split("/").filter((s) => s.length > 0);
}

/**
 * Segment a link path. A segment that contains a `${…}` interpolation is a
 * wildcard (represented as ""), because its value is only known at render time;
 * a purely literal segment is itself. Splitting first, then marking, is what
 * keeps a whole-segment interpolation (`/transaction/${id}` → the id segment)
 * from vanishing — deleting the `${…}` and filtering empties would drop it and
 * silently change the segment count.
 */
function linkSegments(path: string): string[] {
  return split(path).map((s) => (s.includes("${") ? "" : s));
}

/** Does a link path resolve to a registered route of the wanted method? */
function resolves(method: "GET" | "POST", segs: string[], routes: Route[]): boolean {
  return routes.some((r) => {
    if (r.method !== method) return false;
    if (r.segments.length !== segs.length) return false;
    return r.segments.every((rs, i) => {
      const ls = segs[i]!;
      if (rs.startsWith(":")) return true; // a param eats any single segment
      if (ls === "") return true; // an interpolation could be anything
      return rs === ls;
    });
  });
}

interface Link {
  kind: "href" | "action";
  raw: string;
  file: string;
}

/** Extract href/action/formaction literals that start with "/" from a page. */
function linksIn(file: string, source: string): Link[] {
  const out: Link[] = [];
  const re = /(href|action|formaction)="(\/[^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const attr = m[1]!;
    out.push({ kind: attr === "href" ? "href" : "action", raw: m[2]!, file });
  }
  return out;
}

function pageFiles(): string[] {
  const dir = join(here, "pages");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => join(dir, f));
}

describe("B51 · every rendered link resolves to a route", () => {
  const routes = registeredRoutes();

  test("routes were extracted from app.ts", () => {
    // A guard on the guard: if the regex ever stops matching, the whole test
    // would pass vacuously.
    assert.ok(routes.length > 80, `expected many routes, found ${routes.length}`);
  });

  test("no href points at a missing GET and no form action at a missing POST", () => {
    const broken: string[] = [];

    for (const file of pageFiles()) {
      const source = readFileSync(file, "utf8");
      const short = file.split("/").slice(-2).join("/");

      for (const link of linksIn(short, source)) {
        // Query string and fragment are not part of the route.
        const path = link.raw.split(/[?#]/)[0]!;
        if (path === STATIC_PREFIX.slice(0, -1) || path.startsWith(STATIC_PREFIX)) continue;
        // A pure interpolation with no literal segments is unknowable.
        const segs = linkSegments(path);
        if (segs.length === 0) continue;

        // An href reaches a GET; a form action posts. `formaction` is always a
        // POST override, an `href` is always a GET; a bare `action` is a form,
        // which this app only ever POSTs.
        // An `href` is followed as a GET. A form `action` is submitted — this
        // app POSTs most forms but GETs its filter forms (e.g. `/query`), so an
        // action resolves if *either* method has a route; the failure we are
        // hunting is a path with no route at all.
        const ok =
          link.kind === "href"
            ? resolves("GET", segs, routes)
            : resolves("POST", segs, routes) || resolves("GET", segs, routes);
        if (!ok) {
          const want = link.kind === "href" ? "GET" : "POST/GET";
          broken.push(`${link.file}: ${link.kind}="${link.raw}" has no ${want} route`);
        }
      }
    }

    assert.deepEqual(broken, [], `dead links found:\n${broken.join("\n")}`);
  });
});
