import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute, queryAll } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST } from "../core/dates.ts";
import { historyFor } from "../core/events.ts";
import { exportEverything } from "../ops/backup.ts";
import {
  passwordCandidates, describeCandidate, nameKey,
} from "./statement-passwords.ts";
import {
  setIdentity, getIdentity, clearIdentity, maskedIdentity, looksLikePan, looksLikeDob,
} from "./identity.ts";

const RAVI = "m-ravi";
const actor: Actor = { memberId: RAVI, source: "ui" };

/** Not a real identity — the shape is what matters. */
const IDENTITY = { name: "Ravi Kumar", pan: "ABCDE1234F", dob: "01011970" };

function setup() {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    RAVI, "ravi@example.com", "Ravi", nowIST());
  return db;
}

describe("10 §3.6 · deriving a statement password", () => {
  test("Union Bank's rule, quoted from their own email", () => {
    // "If name is 'Ravi Kumar' and date of birth is '01/01/1970', then
    // password will be RAVI0101." Their example, their expected answer.
    const candidates = passwordCandidates(IDENTITY, "union");
    assert.equal(candidates[1], "RAVI0101", "it should be tried first, after no-password");
  });

  test("Axis wants the same thing in lower case, and the order reflects that", () => {
    const axis = passwordCandidates(IDENTITY, "axis");
    const union = passwordCandidates(IDENTITY, "union");
    assert.equal(axis[1], "ravi0101");
    assert.equal(union[1], "RAVI0101");
    // Both still contain both, so a bank that changes its rule still opens.
    assert.ok(axis.includes("RAVI0101"));
    assert.ok(union.includes("ravi0101"));
  });

  test("a broker wants the PAN in lower case", () => {
    assert.equal(passwordCandidates(IDENTITY, "broker")[1], "abcde1234f");
  });

  test("no password is always tried first", () => {
    // Plenty of statements are not protected at all, and it costs one attempt.
    for (const bank of ["axis", "union", "sbi", "broker"] as const) {
      assert.equal(passwordCandidates(IDENTITY, bank)[0], "");
    }
  });

  test("the DDMMYYYY and DDMM forms are both offered", () => {
    const all = passwordCandidates(IDENTITY);
    assert.ok(all.includes("01011970"));
    assert.ok(all.includes("0101"));
  });

  test("a name with spaces or initials still gives four letters", () => {
    assert.equal(nameKey("Ravi Kumar"), "Ravi");
    assert.equal(nameKey("R. K. Nair"), "RKNa");
    assert.equal(nameKey("Jo Li"), "JoLi");
  });

  test("a partial identity still produces what it can", () => {
    const noPan = passwordCandidates({ name: "Ravi Kumar", pan: null, dob: "01011970" });
    assert.ok(noPan.includes("RAVI0101"));
    assert.ok(!noPan.some((c) => c.includes("abcde")));

    const noDob = passwordCandidates({ name: "Ravi Kumar", pan: "ABCDE1234F", dob: null });
    assert.ok(noDob.includes("abcde1234f"));
    assert.ok(!noDob.some((c) => /\d{4}$/.test(c) && c.startsWith("RAVI")));
  });

  test("nothing stored means only the empty password", () => {
    assert.deepEqual(passwordCandidates({ name: "", pan: null, dob: null }), [""]);
  });

  test("what opened it is described, never quoted", () => {
    assert.equal(describeCandidate("", IDENTITY), "no password");
    assert.equal(describeCandidate("abcde1234f", IDENTITY), "your PAN");
    assert.equal(describeCandidate("RAVI0101", IDENTITY), "your name and date of birth");
    assert.equal(describeCandidate("01011970", IDENTITY), "your date of birth");
  });
});

describe("10 §3.6 · storing it, and the three things it must not do", () => {
  test("it round-trips", () => {
    const db = setup();
    setIdentity(db, actor, IDENTITY);
    assert.deepEqual(getIdentity(db, RAVI), { ...IDENTITY, pan: "ABCDE1234F" });
    db.close();
  });

  test("never in an export", () => {
    // F15 exports the whole budget so it can be carried elsewhere. That is
    // exactly why a PAN must not be in it.
    const db = setup();
    setIdentity(db, actor, IDENTITY);

    const exported = JSON.stringify(exportEverything(db));
    assert.ok(!exported.includes("ABCDE1234F"), "the PAN must not travel");
    assert.ok(!exported.includes("01011970"), "nor the date of birth");
    assert.ok(!exported.includes("statement_identity"), "nor the table");
    db.close();
  });

  test("never in the event log", () => {
    // R37 keeps events forever and shows them on the health page.
    const db = setup();
    setIdentity(db, actor, IDENTITY);

    const events = JSON.stringify(historyFor(db, "statement-identity", RAVI));
    assert.ok(!events.includes("ABCDE1234F"));
    assert.ok(!events.includes("01011970"));
    // That it changed is recorded; what it changed to is not.
    assert.match(events, /Updated the details/);
    db.close();
  });

  test("never returned whole to a screen", () => {
    const db = setup();
    setIdentity(db, actor, IDENTITY);

    const masked = maskedIdentity(db, RAVI)!;
    assert.equal(masked.pan, "ABCD••••4F");
    assert.equal(masked.dob, "01/01/••••");
    assert.ok(!JSON.stringify(masked).includes("ABCDE1234F"));
    db.close();
  });

  test("it can be removed", () => {
    const db = setup();
    setIdentity(db, actor, IDENTITY);
    clearIdentity(db, actor);
    assert.equal(getIdentity(db, RAVI), null);
    db.close();
  });

  test("a mistyped PAN or date is refused with the format", () => {
    const db = setup();
    assert.throws(() => setIdentity(db, actor, { name: "Ravi", pan: "NOTAPAN" }), /five letters/);
    assert.throws(() => setIdentity(db, actor, { name: "Ravi", dob: "1970-01-01" }), /DDMMYYYY/);
    assert.throws(() => setIdentity(db, actor, { name: "  " }), /name is needed/);
    db.close();
  });

  test("the validators know the shapes", () => {
    assert.ok(looksLikePan("ABCDE1234F"));
    assert.ok(looksLikePan("abcde1234f"));
    assert.ok(!looksLikePan("ABCD1234F"));
    assert.ok(looksLikeDob("01011970"));
    assert.ok(looksLikeDob("01/01/1970"));
    assert.ok(!looksLikeDob("32011970"));
    assert.ok(!looksLikeDob("01131970"));
  });
});
