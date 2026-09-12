/**
 * B106 · A refusal reaches the household as a sentence, not a 500.
 *
 * The privacy guard was the first refusal written as a Refusal; before that it
 * arrived as "Something went wrong on the server", logged as a defect and shown
 * with none of the explanation that was the point of refusing.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Refusal } from "./refusal.ts";
import { readFileSync } from "node:fs";

describe("B106 · refusals are answers", () => {
  test("a Refusal carries 422 and its own message", () => {
    const r = new Refusal("You cannot do that, and here is why.");
    assert.equal(r.status, 422);
    assert.equal(r.message, "You cannot do that, and here is why.");
    assert.ok(r instanceof Error);
  });

  test("the error hook treats a Refusal as deliberate, so it is neither hidden nor logged", () => {
    // Read rather than exercised: main.ts starts a server and a database, and
    // the property worth pinning is a single decision inside its error hook.
    const main = readFileSync(new URL("../main.ts", import.meta.url), "utf8");
    assert.match(main, /err instanceof Refusal/, "main.ts must recognise a Refusal");
    assert.match(
      main, /if \(!deliberate\) \{/,
      "the fault log and the health record must be skipped for a deliberate answer",
    );
  });
});
