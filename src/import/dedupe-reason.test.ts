/**
 * UI-1 (weekly 25-11) · The manual-vs-imported reason in the review queue
 * names the amount and the date the way every other screen does.
 *
 * It read "You entered ₹2,340.5 by hand on 2026-11-25": the amount went
 * through toLocaleString, which drops a trailing zero, and the date was ISO,
 * beside the row's own "-₹2,340.50 · 25-11-2026".
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { findDuplicate, type Candidate, type Incoming } from "./dedupe.ts";

const manual: Candidate = {
  id: "t1", accountId: "a1", date: "2026-11-25", amount: -234050, payee: "Reliance Fresh",
  reference: null, source: "manual", sourceId: null,
};

const incoming: Incoming = {
  accountId: "a1", date: "2026-11-25", amount: -234050, payee: "Rfresh",
  reference: "UPI400000", source: "csv", sourceId: "row-6",
};

test("the reason says ₹2,340.50 and 25-11-2026, not ₹2,340.5 and 2026-11-25", () => {
  const match = findDuplicate(incoming, [manual]);
  assert.equal(match?.tier, "manual-vs-imported");
  assert.equal(
    match?.reason,
    "You entered ₹2,340.50 by hand on 25-11-2026, and the bank has now sent the same amount.",
  );
});

test("a round amount in lakhs keeps the app's own grouping", () => {
  const big = findDuplicate({ ...incoming, amount: -12500000 }, [{ ...manual, amount: -12500000 }]);
  assert.match(big?.reason ?? "", /^You entered ₹1,25,000 by hand on 25-11-2026,/);
});
