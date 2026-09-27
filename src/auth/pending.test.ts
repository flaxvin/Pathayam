/**
 * OAuth state is single-use, expires after ten minutes, and cannot be grown
 * without bound (SECURITY-OPS-19). With OIDC configured and Google not, a
 * state used an hour later still signed in, and every unauthenticated GET
 * /auth/oidc added a map entry nothing removed.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { PendingStates, PENDING_TTL_MS } from "./pending.ts";

function clock(start = 1_000_000) {
  const c = { t: start, now: () => c.t };
  return c;
}

describe("SECURITY-OPS-19 · pending OAuth state", () => {
  test("is single-use", () => {
    const c = clock();
    const p = new PendingStates<{ at: number }>({ now: c.now });
    p.set("s", { at: c.t });
    assert.ok(p.take("s"));
    assert.equal(p.take("s"), undefined);
  });

  test("expires where it is used, not only where it is pruned", () => {
    const c = clock();
    const p = new PendingStates<{ at: number }>({ now: c.now });
    p.set("s", { at: c.t });
    c.t += 60 * 60_000; // an hour later, with no other sign-in in between
    assert.equal(p.take("s"), undefined);

    p.set("fresh", { at: c.t });
    c.t += PENDING_TTL_MS - 1;
    assert.ok(p.take("fresh"), "just inside ten minutes still works");
  });

  test("every insert prunes the expired and caps the rest, oldest out first", () => {
    const c = clock();
    const p = new PendingStates<{ at: number }>({ now: c.now, cap: 100 });
    for (let i = 0; i < 50; i++) p.set(`old-${i}`, { at: c.t });
    c.t += PENDING_TTL_MS + 1;
    p.set("new", { at: c.t });
    assert.equal(p.size, 1, "the expired were pruned");

    for (let i = 0; i < 10_000; i++) p.set(`flood-${i}`, { at: c.t });
    assert.equal(p.size, 100, "a flood is capped");
    assert.equal(p.take("flood-0"), undefined, "the oldest went first");
    assert.ok(p.take("flood-9999"));
  });
});
