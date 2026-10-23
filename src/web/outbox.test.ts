/**
 * OFFLINE-1 · The write-only queue's decisions, executed.
 *
 * `OUTBOX_LOGIC` is source text spliced into the client script, so these
 * tests run the very functions the browser runs rather than a TypeScript copy
 * of them. What they pin is the part a person would never forgive: an entry
 * dropped without a word, sent twice, or sent as somebody else.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { OUTBOX_LOGIC, OUTBOX_FUNCTIONS } from "./outbox.ts";
import { CLIENT_SCRIPT } from "./client.ts";

type Fn = (...args: any[]) => any;
const q: Record<(typeof OUTBOX_FUNCTIONS)[number], Fn> = new Function(
  `${OUTBOX_LOGIC}\nreturn { ${OUTBOX_FUNCTIONS.join(", ")} };`,
)();

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 22, 6, 0, 0);

function entry(over: Record<string, unknown> = {}) {
  return {
    ...q.outboxEntry({
      key: "k-1",
      member: "m-ravi",
      fields: [["amount", "450"], ["direction", "out"], ["payee", "Chai stall"], ["date", "2026-10-22"]],
      now: NOW,
    }),
    ...over,
  };
}

describe("OFFLINE-1 · what the queue keeps", () => {
  test("is spliced into the client script whole", () => {
    assert.ok(CLIENT_SCRIPT.includes(OUTBOX_LOGIC), "the browser must run the tested code");
    assert.equal(OUTBOX_LOGIC.includes("`"), false);
    assert.equal(OUTBOX_LOGIC.includes("${"), false);
  });

  test("an entry carries its key, its member and what was typed", () => {
    const e = entry();
    assert.equal(e.id, "k-1");
    assert.equal(e.key, "k-1");
    assert.equal(e.member, "m-ravi");
    assert.equal(e.path, "/add");
    assert.equal(e.state, "waiting");
    assert.deepEqual(e.fields[0], ["amount", "450"]);
  });

  test("round-trips through storage, and junk in storage is dropped rather than fatal", () => {
    const stored = q.outboxSerialise([entry()]);
    assert.deepEqual(q.outboxParse(stored), [entry()]);
    assert.deepEqual(q.outboxParse(null), []);
    assert.deepEqual(q.outboxParse("{not json"), []);
    assert.deepEqual(q.outboxParse(JSON.stringify({ a: 1 })), []);
    assert.deepEqual(
      q.outboxParse(JSON.stringify([entry(), { id: "x" }, entry({ path: "/transfer" })])),
      [entry()],
      "only well-formed Add entries survive",
    );
  });

  test("saving a reopened entry again replaces it rather than doubling it", () => {
    const first = [entry()];
    const again = q.outboxPut(first, entry({ key: "k-2", fields: [["amount", "500"]] }));
    assert.equal(again.length, 1);
    assert.equal(again[0].key, "k-2");
    assert.equal(q.outboxPut(again, entry({ id: "k-9", key: "k-9" })).length, 2);
  });
});

describe("OFFLINE-1 · what the server's answer does to an entry", () => {
  test("a confirmed save removes it", () => {
    const r = q.outboxAfterResponse([entry()], "k-1", { status: 200, json: true });
    assert.equal(r.outcome, "sent");
    assert.deepEqual(r.entries, []);
  });

  test("a refusal is kept with the server's words, never dropped", () => {
    const r = q.outboxAfterResponse([entry()], "k-1", {
      status: 422, json: true, error: "Which envelope did this come out of?",
    });
    assert.equal(r.outcome, "refused");
    assert.equal(r.entries.length, 1);
    assert.equal(r.entries[0].state, "refused");
    assert.equal(r.entries[0].message, "Which envelope did this come out of?");
    assert.equal(
      q.outboxAfterResponse([entry()], "k-1", { status: 400, json: true, error: "No." }).entries[0].state,
      "refused", "any other 4xx is a refusal too",
    );
  });

  test("a refused entry is no longer sent automatically", () => {
    const r = q.outboxAfterResponse([entry()], "k-1", { status: 422, json: true, error: "No." });
    assert.deepEqual(q.outboxSendable(r.entries), []);
  });

  test("a busy, broken or still-working server leaves it waiting", () => {
    for (const status of [408, 409, 429, 500, 503]) {
      const r = q.outboxAfterResponse([entry()], "k-1", { status, json: true });
      assert.equal(r.outcome, "later", `status ${status}`);
      assert.equal(r.entries[0].state, "waiting");
    }
  });

  test("an ended session keeps everything until the person signs in", () => {
    const r = q.outboxAfterResponse([entry()], "k-1", { status: 401, json: true });
    assert.equal(r.outcome, "signin");
    assert.equal(r.entries[0].state, "waiting");
  });

  test("a page instead of an answer is a question the queue cannot answer", () => {
    // The "Already reconciled" confirmation comes back as a 200 HTML page.
    const r = q.outboxAfterResponse([entry()], "k-1", { status: 200, json: false });
    assert.equal(r.outcome, "refused");
    assert.match(r.entries[0].message, /confirm/);
  });
});

describe("OFFLINE-1 · whose entries they are", () => {
  test("someone else signing in drops the other member's entries and counts them", () => {
    const mixed = [entry(), entry({ id: "k-p", key: "k-p", member: "m-priya" })];
    const claim = q.outboxClaim(mixed, "m-ravi");
    assert.equal(claim.dropped, 1);
    assert.deepEqual(claim.entries.map((e: { id: string }) => e.id), ["k-1"]);
  });

  test("an entry past the key's lifetime is held for a look, not replayed", () => {
    // R36.3 keeps keys seven days; past that a replay could duplicate.
    const fresh = q.outboxAge([entry()], NOW + 5 * DAY);
    assert.equal(fresh[0].state, "waiting");
    const stale = q.outboxAge([entry()], NOW + 6 * DAY + 1);
    assert.equal(stale[0].state, "refused");
    assert.match(stale[0].message, /not already in your transactions/);
  });
});

describe("OFFLINE-1 · what the person is told", () => {
  test("the count says how many wait and how many need a look", () => {
    assert.equal(q.outboxSummary([]).text, "");
    assert.match(q.outboxSummary([entry()]).text, /^1 entry is saved on this device/);
    const two = [entry(), entry({ id: "k-2", key: "k-2" })];
    assert.match(q.outboxSummary(two).text, /^2 entries are saved on this device/);
    const refused = q.outboxAfterResponse(two, "k-2", { status: 422, json: true, error: "No." }).entries;
    const s = q.outboxSummary(refused);
    assert.equal(s.waiting, 1);
    assert.equal(s.refused, 1);
    assert.match(s.text, /1 entry needs a look/);
  });

  test("an entry is described by what was typed", () => {
    assert.equal(q.outboxDescribe(entry()), "450 out, Chai stall, 2026-10-22");
    assert.equal(
      q.outboxDescribe(entry({ fields: [["amount", "100+20"], ["direction", "in"]] })),
      "100+20 in",
    );
  });
});
