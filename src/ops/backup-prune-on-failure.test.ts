/**
 * WEB-5 · A backup job whose restore did not verify deletes no older backup.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, ensureHousehold } from "../db/db.ts";
import { runBackupJob } from "./backup.ts";

const DAY = 24 * 60 * 60 * 1000;

test("WEB-5 · a failed verification keeps every older backup; a good one prunes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pathayam-prune-"));
  try {
    const backups = join(dir, "backups");
    mkdirSync(backups);
    const db = openDatabase({ path: join(dir, "live.sqlite"), verbose: false });
    ensureHousehold(db);
    const now = Date.now();
    for (let d = 20; d >= 1; d--) {
      const path = join(backups, `budget-old-${String(d).padStart(2, "0")}.sqlite`);
      writeFileSync(path, "x");
      utimesSync(path, new Date(now - d * DAY), new Date(now - d * DAY));
    }
    // Newer than the job's own backup, and not a database: verification fails.
    const broken = join(backups, "budget-broken.sqlite");
    writeFileSync(broken, "not a database");
    utimesSync(broken, new Date(now + DAY), new Date(now + DAY));

    const failed = await runBackupJob(db, { backupDir: backups, webhookUrl: null });
    assert.equal(failed.ok, false);
    assert.equal(readdirSync(backups).filter((f) => f.startsWith("budget-old-")).length, 20);

    rmSync(broken);
    const passed = await runBackupJob(db, { backupDir: backups, webhookUrl: null });
    assert.equal(passed.ok, true, passed.summary);
    assert.equal(readdirSync(backups).length, 14);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
