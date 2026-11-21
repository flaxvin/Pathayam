/**
 * SECURITY-OPS-24 · The health page's backup and verify buttons.
 *
 * On the public demo every visitor is signed in, and each press was a full
 * VACUUM INTO copy on a disk the demo's reset does not clear, never pruned
 * until the six-hourly job — a script could fill the machine. On the demo they
 * are refused; everywhere, a manual backup now prunes like the scheduled one.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDb, seedMember, startTestApp, testConfig } from "./harness.test-data.ts";
import { listBackups, createBackup, lastJobRun, manualBackupTooSoon } from "../ops/backup.ts";

describe("SECURITY-OPS-24 · manual backups", () => {
  test("the demo refuses them, and verification, and writes nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "budget-health-"));
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    const app = await startTestApp(db, {
      memberId: "m-ravi",
      config: testConfig({ demoMode: true, backupDir: dir }),
    });
    try {
      const backup = await app.post("/health/backup", {});
      assert.equal(backup.status, 403);
      assert.match(await backup.text(), /disabled on the demo/);
      assert.equal((await app.post("/health/verify", {})).status, 403);
      assert.equal(listBackups(dir).length, 0);
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a household's manual backup prunes to the same fourteen the job keeps", async () => {
    const dir = mkdtempSync(join(tmpdir(), "budget-health-"));
    mkdirSync(dir, { recursive: true });
    // Twenty older backups already on disk, as repeated presses would leave.
    // Dated an hour and more back: weekly 18-11 #4 refuses a press within ten
    // minutes of the newest.
    const HOUR = 60 * 60 * 1000;
    for (let i = 0; i < 20; i++) {
      const path = join(dir, `budget-2026-01-${String(i + 1).padStart(2, "0")}T00-00-00-000IST.sqlite`);
      writeFileSync(path, "x");
      const at = new Date(Date.now() - (i + 1) * HOUR);
      utimesSync(path, at, at);
    }
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    const app = await startTestApp(db, { memberId: "m-ravi", config: testConfig({ backupDir: dir }) });
    try {
      const res = await app.post("/health/backup", {});
      assert.equal(res.status, 303);
      assert.equal(listBackups(dir).length, 14);
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("WEB-9 · on a plan with BACKUP_RETENTION_DAYS it keeps what the job keeps", async () => {
    const dir = mkdtempSync(join(tmpdir(), "budget-health-"));
    const DAY = 24 * 60 * 60 * 1000;
    const now = Date.now();
    // A daily backup for the last 60 days: all inside a 365-day plan's window.
    for (let d = 60; d >= 3; d--) {
      const path = join(dir, `budget-day-${String(d).padStart(2, "0")}.sqlite`);
      writeFileSync(path, "x");
      utimesSync(path, new Date(now - d * DAY), new Date(now - d * DAY));
    }
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    const app = await startTestApp(db, {
      memberId: "m-ravi",
      config: testConfig({ backupDir: dir, limits: { maxMembers: null, backupRetentionDays: 365 } }),
    });
    try {
      assert.equal((await app.post("/health/backup", {})).status, 303);
      assert.equal(listBackups(dir).length, 59, "every daily backup is still inside the retention window");
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/*
 * Weekly 18-11 #4 · "Back up now" waits ten minutes after the newest backup.
 * Fourteen presses on self-host (keep the newest 14) deleted every earlier
 * day's backup; twenty on a hosted plan (everything from the last two days is
 * kept) left twenty-three full copies.
 */
describe("weekly 18-11 #4 · Back up now, pressed again within ten minutes", () => {
  const MINUTE = 60 * 1000;
  const DAY = 24 * 60 * MINUTE;

  function olderBackups(dir: string, days: number): string[] {
    const paths: string[] = [];
    for (let d = days; d >= 1; d--) {
      const path = join(dir, `budget-day-${String(d).padStart(2, "0")}.sqlite`);
      writeFileSync(path, "x");
      utimesSync(path, new Date(Date.now() - d * DAY), new Date(Date.now() - d * DAY));
      paths.push(path);
    }
    return paths;
  }

  function notice(res: Response): string {
    return decodeURIComponent((res.headers.get("location") ?? "").replace(/\+/g, " "));
  }

  for (const plan of [
    { name: "self-host (newest 14 kept)", retention: null },
    { name: "hosted (BACKUP_RETENTION_DAYS 30)", retention: 30 },
  ]) {
    test(`${plan.name}: fourteen presses take one backup and keep every earlier one`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "budget-health-"));
      const older = olderBackups(dir, 3);
      const db = freshDb();
      seedMember(db, "m-ravi", "Ravi");
      const app = await startTestApp(db, {
        memberId: "m-ravi",
        config: testConfig({ backupDir: dir, limits: { maxMembers: null, backupRetentionDays: plan.retention } }),
      });
      try {
        const first = await app.post("/health/backup", {});
        assert.equal(first.status, 303);
        assert.match(notice(first), /Backed up \d+ bytes/);
        for (let i = 0; i < 13; i++) {
          const again = await app.post("/health/backup", {});
          assert.equal(again.status, 303);
          assert.match(notice(again), /No new backup taken: the last one was taken less than a minute ago, at \d\d:\d\d/);
          assert.match(notice(again), /Another can be taken from \d\d:\d\d/);
        }
        const left = listBackups(dir).map((b) => b.path);
        assert.equal(left.length, 4, "the three earlier days and one new backup");
        for (const path of older) assert.ok(left.includes(path), `${path} kept`);
        assert.deepEqual(app.failures, []);
      } finally {
        await app.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  test("says how long ago the newest was taken, and a press after ten minutes backs up", async () => {
    const dir = mkdtempSync(join(tmpdir(), "budget-health-"));
    const recent = join(dir, "budget-recent.sqlite");
    writeFileSync(recent, "x");
    const threeAgo = new Date(Date.now() - 3 * MINUTE - 5_000);
    utimesSync(recent, threeAgo, threeAgo);
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    const app = await startTestApp(db, { memberId: "m-ravi", config: testConfig({ backupDir: dir }) });
    try {
      const refused = await app.post("/health/backup", {});
      assert.match(notice(refused), /the last one was taken 3 minutes ago/);
      assert.equal(listBackups(dir).length, 1);

      // The same backup, now eleven minutes old (the scheduled job's, say).
      const elevenAgo = new Date(Date.now() - 11 * MINUTE);
      utimesSync(recent, elevenAgo, elevenAgo);
      const taken = await app.post("/health/backup", {});
      assert.match(notice(taken), /Backed up \d+ bytes/);
      assert.equal(listBackups(dir).length, 2);
      assert.deepEqual(app.failures, []);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the message names the newest backup's time and when another may be taken, in IST", () => {
    const dir = mkdtempSync(join(tmpdir(), "budget-health-"));
    try {
      const path = join(dir, "budget-x.sqlite");
      writeFileSync(path, "x");
      // 08:32 UTC is 14:02 IST.
      const taken = new Date("2026-11-21T08:32:00Z");
      utimesSync(path, taken, taken);
      assert.equal(manualBackupTooSoon(dir, new Date("2026-11-21T08:37:30Z")),
        "No new backup taken: the last one was taken 5 minutes ago, at 14:02, and already holds everything. " +
        "Another can be taken from 14:12.");
      assert.equal(manualBackupTooSoon(dir, new Date("2026-11-21T08:42:00Z")), null, "ten minutes on");
      assert.equal(manualBackupTooSoon(dir, new Date("2026-11-21T08:20:00Z")), null, "stamped in the future");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/*
 * DEBUG-WEB-8 · The heartbeat a verify sends. It went out through the global
 * fetch rather than the app's own, and its result was written with no catch:
 * a write that failed — the database closed under a shutdown, a locked file —
 * was an unhandled rejection, which ends a Node 24 process.
 */
describe("DEBUG-WEB-8 · the heartbeat after a manual verify", () => {
  async function verifyWith(fetchImpl: typeof fetch) {
    const dir = mkdtempSync(join(tmpdir(), "budget-health-"));
    const db = freshDb();
    seedMember(db, "m-ravi", "Ravi");
    createBackup(db, dir);
    const app = await startTestApp(db, {
      memberId: "m-ravi", fetchImpl,
      config: testConfig({ backupDir: dir, heartbeatUrl: "https://monitor.example/ping" }),
    });
    const res = await app.post("/health/verify", {});
    return { db, app, res, done: () => rmSync(dir, { recursive: true, force: true }) };
  }

  test("goes out through the app's fetch and is recorded", async () => {
    const calls: string[] = [];
    const { db, app, res, done } = await verifyWith(
      (async (url: string | URL | Request) => { calls.push(String(url)); return new Response("ok"); }) as typeof fetch,
    );
    try {
      assert.equal(res.status, 303);
      await new Promise((ok) => setTimeout(ok, 20));
      assert.deepEqual(calls, ["https://monitor.example/ping"]);
      assert.equal(lastJobRun(db, "heartbeat").status, "ok");
      assert.deepEqual(app.failures, []);
    } finally { await app.close(); done(); }
  });

  test("a record that cannot be written is not an unhandled rejection", async () => {
    let answer!: (r: Response) => void;
    const pending = new Promise<Response>((ok) => { answer = ok; });
    const rejections: unknown[] = [];
    const listen = (reason: unknown) => { rejections.push(reason); };
    process.on("unhandledRejection", listen);
    const { db, app, res, done } = await verifyWith((async () => pending) as typeof fetch);
    try {
      assert.equal(res.status, 303);
      await app.close();
      db.close();
      answer(new Response("ok"));
      await new Promise((ok) => setTimeout(ok, 20));
      assert.deepEqual(rejections, []);
    } finally { process.off("unhandledRejection", listen); done(); }
  });
});
