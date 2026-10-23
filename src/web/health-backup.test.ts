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
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDb, seedMember, startTestApp, testConfig } from "./harness.test-data.ts";
import { listBackups, createBackup, lastJobRun } from "../ops/backup.ts";

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
    for (let i = 0; i < 20; i++) {
      writeFileSync(join(dir, `budget-2026-01-${String(i + 1).padStart(2, "0")}T00-00-00-000IST.sqlite`), "x");
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
