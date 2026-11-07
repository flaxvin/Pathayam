/**
 * MERGE-1 · A Gmail fetch that needs card digits lands on Settings, not on the
 * SafeGold review. The fetch has already moved past the SafeGold mail, so the
 * review link must survive that redirect or the gold is never offered again.
 * Settings shows it only for a plan still stashed for this same member.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { freshDb, seedMember, startTestApp } from "./harness.test-data.ts";
import { stashSafeGoldPlan, type SafeGoldPlan } from "../import/safegold-plan.ts";

const plan = {} as SafeGoldPlan; // Settings only checks that a plan exists.

describe("MERGE-1 · Settings links a SafeGold review left by the same fetch", () => {
  test("own plan → link; unknown or another member's token → nothing", async () => {
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    seedMember(db, "m-priya", "Priya");
    stashSafeGoldPlan("tok-ravi", plan, "m-ravi");
    stashSafeGoldPlan("tok-priya", plan, "m-priya");
    const app = await startTestApp(db, { memberId: "m-ravi" });
    try {
      const own = await (await app.get("/settings?card_digits=x:4&gold=tok-ravi")).text();
      assert.match(own, /id="gold-waiting"/);
      assert.match(own, /\/portfolio\/safegold\/review\?token=tok-ravi/);
      for (const token of ["nope", "tok-priya"]) {
        const page = await (await app.get(`/settings?gold=${token}`)).text();
        assert.doesNotMatch(page, /id="gold-waiting"/, token);
      }
    } finally {
      await app.close();
    }
  });
});
