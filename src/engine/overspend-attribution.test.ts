/**
 * DEBUG-ENGINE-6 · A card overspend is shared out without any card going negative.
 *
 * The shortfall was split across the cards a category charged by rounding each
 * share to the nearest paisa and handing the last card whatever was left. With
 * four equal cards and a 2-paise overspend the first three were each rounded up
 * to 1 paisa and the last got −1: that card was told it was *over*-funded, and
 * its payment envelope was handed a paisa no category gave up.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeBudget, identityResidual } from "./engine.ts";
import { Scenario } from "./scenario.ts";

test("no card's share of an overspend is negative, and the shares add up", () => {
  const s = new Scenario("2026-08").category("food").income("2026-08", 5_000);
  for (const card of ["c1", "c2", "c3", "c4"]) s.paymentCategory(`pay-${card}`, card);
  s.assign("2026-08", "food", 1_199.98);
  for (const card of ["c1", "c2", "c3", "c4"]) s.spendCard("2026-08", card, "food", 300);

  const state = computeBudget(s.build()).get("2026-08")!;
  const shares = Object.values(state.unfundedByAccount);
  assert.equal(shares.reduce((a, b) => a + b, 0), 2, "the whole 2 paise is attributed");
  for (const share of shares) assert.ok(share >= 0, `a share of ${share} paise`);
  assert.equal(identityResidual(state), 0);
});
