/**
 * WEB-2 · BACKUP_RETENTION_DAYS=unlimited.
 *
 * docs/operations.md offers "Days, 1 to 3650, or `unlimited`". The parser
 * read "unlimited" (and "0") as unset, and unset means the self-hosted rule:
 * the newest 14 backups, whatever their age. So a Power instance whose
 * operator lifted the 365-day limit had every backup but the newest 14 — three
 * and a half days at the six-hourly cadence — deleted by the next backup job.
 * Unlimited is no age limit: the last two days in full, then one a day, kept.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, ensureHousehold } from "../db/db.ts";
import { loadConfig } from "../config.ts";
import { runBackupJob } from "./backup.ts";

const base = { BASE_URL: "http://localhost:8080" };
const DAY = 24 * 60 * 60 * 1000;

describe("WEB-2 · an unlimited backup retention keeps old backups", () => {
  for (const value of ["unlimited", "0"]) {
    test(`PLAN=power, BACKUP_RETENTION_DAYS=${value}: a year of daily backups survives the job`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "pathayam-unlimited-"));
      try {
        const config = loadConfig({ ...base, PLAN: "power", BACKUP_RETENTION_DAYS: value });
        const backups = join(dir, "backups");
        const db = openDatabase({ path: join(dir, "live.sqlite"), verbose: false });
        ensureHousehold(db);
        // One a day for 400 days, the oldest first.
        const now = Date.now();
        const { mkdirSync } = await import("node:fs");
        mkdirSync(backups, { recursive: true });
        for (let d = 400; d >= 3; d--) {
          const path = join(backups, `budget-day-${String(d).padStart(3, "0")}.sqlite`);
          writeFileSync(path, "x");
          const t = new Date(now - d * DAY);
          utimesSync(path, t, t);
        }
        await runBackupJob(db, {
          backupDir: backups, webhookUrl: null,
          retentionDays: config.limits.backupRetentionDays,
        });
        db.close();
        const left = readdirSync(backups).filter((f) => f.startsWith("budget-day-"));
        assert.equal(left.length, 398, `only ${left.length} of 398 old daily backups are left`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  test("unset still means the plan's own limit", () => {
    assert.equal(loadConfig({ ...base, PLAN: "power" }).limits.backupRetentionDays, 365);
    assert.equal(loadConfig({ ...base }).limits.backupRetentionDays, null);
  });
});
