/**
 * IMPORTS-SCHEDULES-5 · docs/money-in.md states the dedupe tiers dedupe.ts runs.
 *
 * The table said `probable` was "close on date and amount" and `weak` a
 * "weaker match", and listed manual-vs-imported last. The code asks for the
 * same payee within 3 days (probable), the same amount within 1 day (weak),
 * checks a hand-typed match within 5 days before either, and never calls a
 * same-date, same-narration row without a reference `strong`. These pin the
 * behaviour and that the doc says it.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { IsoDate } from "../core/dates.ts";
import type { Paise } from "../core/money.ts";
import { findDuplicate, STRONG_WINDOW_DAYS, type Candidate, type Incoming } from "./dedupe.ts";

const base: Candidate = {
  id: "t1", accountId: "a", date: "2026-09-10" as IsoDate, amount: -45_000 as Paise,
  payee: "ZZ Cafe", reference: null, source: "csv", sourceId: "csv:x:1",
};
const incoming = (over: Partial<Incoming>): Incoming => ({
  accountId: "a", date: "2026-09-10" as IsoDate, amount: -45_000 as Paise,
  payee: "ZZ Cafe", reference: null, source: "pdf", sourceId: "pdf:y:1", ...over,
});
const tier = (inc: Incoming, c: Candidate = base) => findDuplicate(inc, [c])?.tier ?? null;

describe("IMPORTS-SCHEDULES-5 · the dedupe tiers, as documented", () => {
  test("same date, amount and payee without a reference is probable, not strong", () => {
    assert.equal(tier(incoming({})), "probable");
  });

  test("probable needs the payee and 3 days; weak is 1 day; manual is 5 days, checked first", () => {
    assert.equal(tier(incoming({ date: "2026-09-13" as IsoDate })), "probable");
    assert.equal(tier(incoming({ date: "2026-09-14" as IsoDate })), null);
    assert.equal(tier(incoming({ payee: "ZZ Bakery", date: "2026-09-11" as IsoDate })), "weak");
    assert.equal(tier(incoming({ payee: "ZZ Bakery", date: "2026-09-12" as IsoDate })), null);
    const typed = { ...base, source: "manual", sourceId: null };
    assert.equal(tier(incoming({}), typed), "manual-vs-imported");
    assert.equal(tier(incoming({ date: "2026-09-15" as IsoDate }), typed), "manual-vs-imported");
    assert.equal(tier(incoming({ date: "2026-09-16" as IsoDate, payee: null }), typed), null);
  });

  test("docs/money-in.md's table says the same", () => {
    const doc = readFileSync(new URL("../../docs/money-in.md", import.meta.url), "utf8");
    const row = (t: string) => doc.split("\n").find((l) => l.startsWith(`| \`${t}\` |`)) ?? "";
    assert.match(row("strong"), new RegExp(`bank reference.*within ${STRONG_WINDOW_DAYS} days`));
    assert.match(row("probable"), /same payee.*within 3 days/);
    assert.match(row("weak"), /within 1 day.*different payee/);
    assert.match(row("manual-vs-imported"), /typed by hand.*within 5 days/);
    // In the order the code checks them.
    const order = ["exact", "strong", "manual-vs-imported", "probable", "weak"].map((t) => doc.indexOf(row(t)));
    assert.deepEqual([...order].sort((x, y) => x - y), order);
    assert.match(doc, /without\s+a bank reference is not `strong`/);
  });
});
