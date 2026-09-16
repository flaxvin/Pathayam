/**
 * When a statement will not open, say which detail is missing.
 *
 * Four of the twelve institutions in one household's inbox need a digit that
 * name + date of birth + PAN does not carry, and against a corpus of
 * seventy-seven real statements those four account for **every single file**
 * that could not be opened: SBI wants the registered mobile, SBI Card and
 * Canara the card's last four, HSBC its last six.
 *
 * Told only "none of the passwords worked", a household has no way to know the
 * fix is one field in Settings rather than a lost cause.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { missingDetailFor } from "./statement-passwords.ts";
import { bankForInstitution } from "./pdf-statements.ts";

const FULL = { name: "Ravi", pan: "ABCDE1234F", dob: "01011990", mobile: "9876512345" };
const NO_MOBILE = { ...FULL, mobile: null };

describe("which detail the bank's rule needs", () => {
  test("SBI's account statement needs the registered mobile", () => {
    const said = missingDetailFor("sbi", NO_MOBILE, ["4321"]);
    assert.match(said!, /mobile/i);
    assert.match(said!, /Settings/);
  });

  test("Canara needs the card's last four", () => {
    assert.match(missingDetailFor("canara", FULL, [])!, /last four/i);
    // …and says nothing once the account has them.
    assert.equal(missingDetailFor("canara", FULL, ["4321"]), null);
  });

  test("HSBC needs six, and says so even when four are known", () => {
    const said = missingDetailFor("hsbc", FULL, ["4321"]);
    assert.match(said!, /last six/i);
    assert.match(said!, /only the last four/i);
    assert.equal(missingDetailFor("hsbc", FULL, ["998877"]), null);
  });

  test("a bank whose rule needs nothing extra says nothing", () => {
    // Otherwise it sends somebody to fill in a form that is already full.
    for (const bank of ["hdfc", "icici", "axis", "yes", null] as const) {
      assert.equal(missingDetailFor(bank, NO_MOBILE, []), null, `${bank} invented a missing detail`);
    }
  });

  test("the account's own institution names the bank, before the file is opened", () => {
    // detectBank reads the statement text, which is exactly what a locked file
    // will not give up — so the password rule has to come from somewhere else.
    assert.equal(bankForInstitution("State Bank of India"), "sbi");
    assert.equal(bankForInstitution("Canara Bank"), "canara");
    assert.equal(bankForInstitution("HSBC India"), "hsbc");
    assert.equal(bankForInstitution("Some Credit Union"), null);
    assert.equal(bankForInstitution(null), null);
  });
});
