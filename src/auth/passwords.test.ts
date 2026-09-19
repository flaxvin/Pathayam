/**
 * Password sign-in.
 *
 * The thing under test is not "does the right password work" — it is what
 * happens on every other path: a wrong one, a hostile stored row, a member who
 * has no password at all, and somebody guessing patiently.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, ensureHousehold, execute } from "../db/db.ts";
import { nowIST } from "../core/dates.ts";
import {
  hashPassword, verifyPassword, needsRehash, assertUsablePassword, WeakPassword,
  setPassword, checkPassword, hasPassword, anyPasswordSet, clearPassword, getPasswordRow,
} from "./passwords.ts";

const GOOD = "correct horse battery staple";

function household() {
  const db = openDatabase({ path: ":memory:", verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    "m1", "ravi@example.com", "Ravi", nowIST());
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    "m2", "priya@example.com", "Priya", nowIST());
  return db;
}

describe("the hash", () => {
  test("verifies the password it was made from, and nothing else", () => {
    const h = hashPassword(GOOD);
    assert.ok(verifyPassword(GOOD, h));
    assert.ok(!verifyPassword(GOOD + " ", h));
    assert.ok(!verifyPassword("", h));
    assert.ok(!verifyPassword("Correct Horse Battery Staple", h));
  });

  test("the same password twice gives different hashes", () => {
    // Otherwise the file tells an attacker which members share a password.
    assert.notEqual(hashPassword(GOOD), hashPassword(GOOD));
  });

  test("the plaintext appears nowhere in the stored form", () => {
    assert.ok(!hashPassword(GOOD).includes("horse"));
  });

  test("unicode that looks identical verifies", () => {
    // NFKC, so a password typed on a different keyboard still opens the door.
    const composed = "café-passphrase-1";           // é as one code point
    const decomposed = "café-passphrase-1";   // e + combining acute
    assert.ok(verifyPassword(decomposed, hashPassword(composed)));
  });

  test("a corrupt or hostile stored row fails, it does not throw", () => {
    // This runs on the sign-in path; an exception here is a 500 on a login page.
    for (const bad of [
      "", "not-a-hash", "scrypt$x$8$1$AAAA$AAAA", "scrypt$32768$8$1$$", "bcrypt$1$2$3$4$5",
      "scrypt$32768$8$1$!!!notbase64!!!$AAAA",
    ]) {
      assert.doesNotThrow(() => verifyPassword(GOOD, bad), `threw on ${bad}`);
      assert.equal(verifyPassword(GOOD, bad), false, `accepted ${bad}`);
    }
  });

  test("a stored row cannot demand unbounded memory", () => {
    // N is attacker-controlled if the database is. scryptSync would happily
    // try to allocate what it names.
    const bomb = `scrypt$1073741824$32$16$${Buffer.from("s").toString("base64")}$${Buffer.from("k").toString("base64")}`;
    assert.equal(verifyPassword(GOOD, bomb), false);
  });

  test("needsRehash spots weaker parameters", () => {
    assert.ok(!needsRehash(hashPassword(GOOD)));
    assert.ok(needsRehash("scrypt$16384$8$1$AAAA$AAAA"));
    assert.ok(needsRehash("garbage"));
  });
});

describe("what counts as usable", () => {
  test("length is the rule", () => {
    assert.throws(() => assertUsablePassword("short1!"), WeakPassword);
    assert.doesNotThrow(() => assertUsablePassword("a-perfectly-ordinary-phrase"));
  });

  test("the passwords everybody tries first are refused", () => {
    for (const p of ["password123", "PASSWORD123", "budget123", "pathayam"]) {
      assert.throws(() => assertUsablePassword(p), WeakPassword, `accepted ${p}`);
    }
  });

  test("one character repeated is refused however long", () => {
    assert.throws(() => assertUsablePassword("aaaaaaaaaaaaaaaaaaaa"), WeakPassword);
  });
});

describe("signing in", () => {
  test("the right password is accepted, the wrong one is not", () => {
    const db = household();
    setPassword(db, "m1", GOOD);
    assert.deepEqual(checkPassword(db, "m1", GOOD), { ok: true, mustChange: false });
    assert.equal(checkPassword(db, "m1", "wrong-but-long-enough").ok, false);
  });

  test("a member with no password is not signed in by an empty one", () => {
    const db = household();
    assert.equal(hasPassword(db, "m2"), false);
    const r = checkPassword(db, "m2", "");
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, "no-password");
  });

  test("patient guessing locks the credential, not just the address", () => {
    const db = household();
    setPassword(db, "m1", GOOD);
    let last;
    for (let i = 0; i < 8; i++) last = checkPassword(db, "m1", `guess-number-${i}-long`);
    assert.equal(last!.ok, false);
    assert.equal(last!.ok === false && last!.reason, "locked");

    // And the correct password does not open it while locked.
    const now = checkPassword(db, "m1", GOOD);
    assert.equal(now.ok, false, "a lock that the real password walks through is not a lock");
  });

  test("a successful sign-in clears the failures behind it", () => {
    const db = household();
    setPassword(db, "m1", GOOD);
    checkPassword(db, "m1", "wrong-but-long-enough");
    checkPassword(db, "m1", "wrong-but-long-enough");
    assert.equal(getPasswordRow(db, "m1")!.failed_count, 2);
    assert.ok(checkPassword(db, "m1", GOOD).ok);
    assert.equal(getPasswordRow(db, "m1")!.failed_count, 0);
  });

  test("one member's password is not another's", () => {
    const db = household();
    setPassword(db, "m1", GOOD);
    setPassword(db, "m2", "a-different-long-password");
    assert.equal(checkPassword(db, "m2", GOOD).ok, false);
  });

  test("an assigned password must be changed; a chosen one need not", () => {
    const db = household();
    setPassword(db, "m1", GOOD, { mustChange: true });
    assert.deepEqual(checkPassword(db, "m1", GOOD), { ok: true, mustChange: true });
    setPassword(db, "m1", "a-password-of-their-own");
    assert.deepEqual(checkPassword(db, "m1", "a-password-of-their-own"), { ok: true, mustChange: false });
  });

  test("setting a password refuses a weak one before it is stored", () => {
    const db = household();
    assert.throws(() => setPassword(db, "m1", "password123"), WeakPassword);
    assert.equal(hasPassword(db, "m1"), false, "a refused password was stored anyway");
  });

  test("clearing removes the credential entirely", () => {
    const db = household();
    setPassword(db, "m1", GOOD);
    assert.ok(anyPasswordSet(db));
    clearPassword(db, "m1");
    assert.equal(hasPassword(db, "m1"), false);
    assert.equal(anyPasswordSet(db), false);
  });

  test("removing a member takes the credential with them", () => {
    const db = household();
    setPassword(db, "m1", GOOD);
    execute(db, `DELETE FROM members WHERE id = ?`, "m1");
    assert.equal(hasPassword(db, "m1"), false, "a deleted member left a usable credential behind");
  });
});
