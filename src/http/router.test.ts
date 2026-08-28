/**
 * B51 · Router matching prefers the most specific route.
 *
 * `/portfolio/holdings.csv` used to be served by `/portfolio/:id` — a literal
 * route made unreachable by a param route registered before it, so the CSV
 * download 404'd. The matcher now scores by literal-segment count, so the
 * literal wins whatever the registration order.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Router, type RequestContext, type Response } from "./router.ts";

const ok = (name: string): (() => Response) => () => ({ body: name });
const hit = (r: Router, method: string, path: string): string | null => {
  const m = r.match(method, path);
  if (!m) return null;
  return (m.handler({} as RequestContext) as Response).body as string;
};

describe("B51 · Router.match specificity", () => {
  test("a literal route wins over a param route registered before it", () => {
    const r = new Router();
    r.get("/portfolio/:id", ok("param")); // registered FIRST — used to shadow
    r.get("/portfolio/holdings.csv", ok("literal"));

    assert.equal(hit(r, "GET", "/portfolio/holdings.csv"), "literal");
    // and a real id still reaches the param route
    assert.equal(hit(r, "GET", "/portfolio/abc123"), "param");
  });

  test("order does not matter — literal wins even when registered after", () => {
    const r = new Router();
    r.get("/portfolio/holdings.csv", ok("literal"));
    r.get("/portfolio/:id", ok("param"));
    assert.equal(hit(r, "GET", "/portfolio/holdings.csv"), "literal");
  });

  test("the param route captures the segment it matches", () => {
    const r = new Router();
    r.get("/loans/:id/statement", ok("stmt"));
    const m = r.match("GET", "/loans/xyz/statement");
    assert.equal(m?.params.id, "xyz");
  });

  test("method still segregates routes", () => {
    const r = new Router();
    r.post("/transfer", ok("post"));
    assert.equal(hit(r, "GET", "/transfer"), null);
    assert.equal(hit(r, "POST", "/transfer"), "post");
  });

  test("a deeper literal path outscores a shallower param overlap", () => {
    const r = new Router();
    r.get("/portfolio/:id", ok("param"));
    r.get("/portfolio/asset/new", ok("asset-new"));
    assert.equal(hit(r, "GET", "/portfolio/asset/new"), "asset-new");
  });
});
