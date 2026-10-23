/**
 * `npm run password-link` — the way in that does not depend on another member.
 *
 * Two people need it: somebody whose private records mean no other member may
 * make them a link, and somebody who has forgotten a password they already
 * have. Both are a decision for whoever runs the server, so it is a command on
 * the server, and it changes nothing until told to.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { freshDb, seedMember, testConfig } from "./web/harness.test-data.ts";
import { runPasswordLink } from "./password-link.ts";
import { setPassword, hasPassword, checkPassword } from "./auth/passwords.ts";
import { redeemSetupLink, unusedSetupLinks, issueSetupLink } from "./auth/setup-links.ts";
import { createSession, listSessions } from "./auth/sessions.ts";
import { openDatabase, ensureHousehold, execute, queryOne } from "./db/db.ts";
import { nowIST } from "./core/dates.ts";

const GOOD = "seven pathayam granary evenings";

function run(db: ReturnType<typeof freshDb>, ...argv: string[]) {
  const out: string[] = [];
  const code = runPasswordLink(argv, {
    db, config: testConfig({ baseUrl: "https://pathayam.example" }),
    out: (line) => out.push(line), err: (line) => out.push(line),
  });
  return { code, text: out.join("\n") };
}

function household() {
  const db = freshDb();
  seedMember(db, "m-ravi", "Ravi");
  seedMember(db, "m-priya", "Priya");
  return db;
}

const tokenIn = (text: string) =>
  /https:\/\/pathayam\.example\/auth\/setup\/([A-Za-z0-9_-]{43})/.exec(text)?.[1] ?? null;

const eventCount = (db: ReturnType<typeof freshDb>) =>
  queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM events`)!.n;

describe("a dry run by default", () => {
  test("says who, and what would happen, and changes nothing", () => {
    const db = household();
    const before = eventCount(db);
    const { code, text } = run(db, "m-priya@example.com");
    assert.equal(code, 0, text);
    assert.match(text, /Priya/);
    assert.match(text, /m-priya@example\.com/);
    assert.match(text, /no password/i);
    assert.match(text, /unused links?:\s*0/i);
    assert.match(text, /dry run/i);
    assert.match(text, /--execute/);
    assert.equal(tokenIn(text), null, "a dry run printed a working link");
    assert.equal(unusedSetupLinks(db, "m-priya"), 0);
    assert.equal(eventCount(db), before, "a dry run wrote to the log");
  });

  test("an address in any case finds the member", () => {
    const { code } = run(household(), "M-Priya@Example.COM");
    assert.equal(code, 0);
  });
});

describe("--execute", () => {
  test("issues a link that works, and prints it once", () => {
    const db = household();
    const { code, text } = run(db, "m-priya@example.com", "--execute");
    assert.equal(code, 0, text);
    const token = tokenIn(text);
    assert.ok(token, `no link printed:\n${text}`);
    assert.match(text, /unused links?:\s*0/i, "no before count");
    assert.match(text, /unused links?:\s*1/i, "no after count");
    redeemSetupLink(db, token, GOOD);
    assert.equal(checkPassword(db, "m-priya", GOOD).ok, true);
  });

  test("works for somebody whose private records stop other members making one", () => {
    const db = household();
    execute(
      db, `INSERT INTO statement_identity (member_id, name, pan, dob, updated_at) VALUES (?,?,?,?,?)`,
      "m-priya", "PRIYA", "ABCDE1234F", "01011990", nowIST(),
    );
    const { code, text } = run(db, "m-priya@example.com", "--execute");
    assert.equal(code, 0, text);
    assert.ok(tokenIn(text));
  });

  test("replaces a link made earlier", () => {
    const db = household();
    const earlier = issueSetupLink(db, { memberId: "m-ravi", source: "ui" }, "m-priya", "m-ravi").token;
    const { text } = run(db, "m-priya@example.com", "--execute");
    assert.match(text, /unused links?:\s*1/i);
    assert.throws(() => redeemSetupLink(db, earlier, GOOD));
    redeemSetupLink(db, tokenIn(text)!, GOOD);
  });
});

describe("a member who already has a password", () => {
  test("--execute alone is refused and nothing changes", () => {
    const db = household();
    setPassword(db, "m-priya", "priya's forgotten password");
    const { code, text } = run(db, "m-priya@example.com", "--execute");
    assert.equal(code, 1);
    assert.match(text, /--reset/);
    assert.equal(tokenIn(text), null);
    assert.equal(checkPassword(db, "m-priya", "priya's forgotten password").ok, true);
  });

  test("the dry run says --reset would be needed", () => {
    const db = household();
    setPassword(db, "m-priya", "priya's forgotten password");
    const { code, text } = run(db, "m-priya@example.com", "--reset");
    assert.equal(code, 0);
    assert.match(text, /password:\s*set/i);
    assert.match(text, /clear/i);
    assert.equal(hasPassword(db, "m-priya"), true, "a dry run with --reset cleared it");
  });

  test("--execute --reset clears it, signs her out everywhere, and issues a link", () => {
    const db = household();
    setPassword(db, "m-priya", "priya's forgotten password");
    createSession(db, "m-priya", { days: 30 });
    createSession(db, "m-priya", { days: 30 });
    const { code, text } = run(db, "m-priya@example.com", "--execute", "--reset");
    assert.equal(code, 0, text);
    assert.equal(hasPassword(db, "m-priya"), false);
    assert.equal(listSessions(db, "m-priya").length, 0, "her sessions outlived the reset");
    assert.match(text, /sessions?:\s*2/i, "no before count of sessions");
    assert.match(text, /sessions?:\s*0/i, "no after count of sessions");
    redeemSetupLink(db, tokenIn(text)!, GOOD);
    assert.equal(checkPassword(db, "m-priya", "priya's forgotten password").ok, false);
  });
});

describe("refusals and mistakes", () => {
  test("nobody by that address", () => {
    const { code, text } = run(household(), "stranger@example.com", "--execute");
    assert.equal(code, 1);
    assert.match(text, /no member/i);
  });

  test("a removed member is added back first, from Settings", () => {
    const db = household();
    execute(db, `UPDATE members SET removed_at = ?, allowed = 0 WHERE id = 'm-priya'`, nowIST());
    const { code, text } = run(db, "m-priya@example.com", "--execute");
    assert.equal(code, 1);
    assert.match(text, /removed/i);
    assert.equal(unusedSetupLinks(db, "m-priya"), 0);
  });

  test("no address, two addresses, or an unknown flag is a usage error", () => {
    for (const argv of [[], ["a@example.com", "b@example.com"], ["a@example.com", "--force"]]) {
      const { code, text } = run(household(), ...argv);
      assert.equal(code, 2, `${argv.join(" ")} → ${text}`);
      assert.match(text, /usage/i);
    }
  });

  test("--help is not an error", () => {
    const { code, text } = run(household(), "--help");
    assert.equal(code, 0);
    assert.match(text, /--execute/);
  });
});

describe("the npm script runs it against the configured database", () => {
  test("a dry run, end to end", () => {
    const dir = mkdtempSync(join(tmpdir(), "pathayam-password-link-"));
    try {
      const path = join(dir, "pathayam.sqlite");
      const db = openDatabase({ path, verbose: false });
      ensureHousehold(db);
      seedMember(db, "m-priya", "Priya");
      db.close();

      const root = dirname(fileURLToPath(import.meta.url));
      const result = spawnSync(
        process.execPath,
        ["--experimental-strip-types", "--no-warnings", join(root, "password-link.ts"), "m-priya@example.com"],
        { env: { ...process.env, DATABASE_PATH: path, DATA_DIR: dir, NODE_ENV: "development" }, encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stderr + result.stdout);
      assert.match(result.stdout, /Priya/);
      assert.match(result.stdout, /dry run/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
