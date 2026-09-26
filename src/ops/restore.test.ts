/**
 * B91 · The footgun on the recovery path.
 *
 * SQLite in WAL mode keeps a `-wal` and a `-shm` beside the database. Copying a
 * backup over `pathayam.sqlite` and leaving those in place gives SQLite a fresh
 * database with a crashed instance's journal next to it, and the first query
 * answers "database disk image is malformed".
 *
 * That is not an exotic case. After a crash — precisely when a restore is
 * wanted — the sidecars are always there, and copying the file over is the
 * obvious thing to do. R40 made verified restore a shipping requirement and the
 * app proved nightly that it *could* restore; nothing said how, so the obvious
 * way turned a recoverable afternoon into a corrupt database.
 *
 * This test exists to keep the trap documented in executable form.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, copyFileSync, existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, ensureHousehold, execute, queryAll } from "../db/db.ts";
import { nowIST } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import type { Actor } from "../core/events.ts";
import { createAccount } from "../domain/accounts.ts";
import { createTransaction } from "../domain/transactions.ts";
import { createBackup, controlTotals, listBackups } from "./backup.ts";

const actor: Actor = { memberId: "m", source: "ui" };

function household(dir: string) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "pathayam.sqlite");
  const db = openDatabase({ path, verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    "m", "f@e.com", "Ravi", nowIST());
  const account = createAccount(db, actor, {
    name: "HDFC", kind: "budget", subtype: "savings",
    openingDate: "2026-01-01", openingBalance: rupees(100000),
  }).id;
  for (let i = 0; i < 5; i++) {
    createTransaction(db, actor, {
      accountId: account, amount: -rupees(500 + i), date: "2026-09-05", payeeName: `Shop ${i}`,
    });
  }
  return { db, path };
}

describe("B91 · restoring over a stale write-ahead log", () => {
  test("copying a backup over the database with the sidecars left behind corrupts it", () => {
    const dir = mkdtempSync(join(tmpdir(), "budget-restore-"));
    try {
      const { db, path } = household(dir);
      const backup = createBackup(db, join(dir, "backups"));
      db.close();

      // A real journal, captured the way a crash leaves one: written but not
      // yet checkpointed. A synthetic buffer will not do — SQLite reads the WAL
      // header first and simply ignores a file that is not one, so the test
      // would pass while proving nothing.
      const crashed = household(join(dir, "crashed"));
      for (let i = 0; i < 200; i++) {
        createTransaction(crashed.db, actor, {
          accountId: queryAll<{ id: string }>(
            crashed.db, `SELECT id FROM accounts LIMIT 1`,
          )[0]!.id,
          amount: -rupees(100 + i), date: "2026-09-06", payeeName: `Hot ${i}`,
        });
      }
      // Take the sidecars while they are still live, before close checkpoints them.
      copyFileSync(`${crashed.path}-wal`, join(dir, "hot-wal"));
      copyFileSync(`${crashed.path}-shm`, join(dir, "hot-shm"));
      crashed.db.close();

      copyFileSync(backup.path, path);
      copyFileSync(join(dir, "hot-wal"), `${path}-wal`);
      copyFileSync(join(dir, "hot-shm"), `${path}-shm`);

      assert.throws(
        () => {
          const reopened = openDatabase({ path, verbose: false });
          controlTotals(reopened);
        },
        /malformed|not a database|corrupt/i,
        "if this stops throwing, the trap is gone and the warning can go with it",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("removing them first restores the ledger intact", () => {
    const dir = mkdtempSync(join(tmpdir(), "budget-restore-"));
    try {
      const { db, path } = household(dir);
      const before = controlTotals(db);
      const backup = createBackup(db, join(dir, "backups"));
      db.close();

      const crashed = household(join(dir, "crashed"));
      for (let i = 0; i < 200; i++) {
        createTransaction(crashed.db, actor, {
          accountId: queryAll<{ id: string }>(
            crashed.db, `SELECT id FROM accounts LIMIT 1`,
          )[0]!.id,
          amount: -rupees(100 + i), date: "2026-09-06", payeeName: `Hot ${i}`,
        });
      }
      copyFileSync(`${crashed.path}-wal`, `${path}-wal`);
      copyFileSync(`${crashed.path}-shm`, `${path}-shm`);
      crashed.db.close();

      // The whole of the fix.
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
      copyFileSync(backup.path, path);

      const reopened = openDatabase({ path, verbose: false });
      const after = controlTotals(reopened);
      reopened.close();

      assert.equal(after.counts.transactions, before.counts.transactions);
      assert.equal(after.transactionTotal, before.transactionTotal);
      assert.equal(after.counts.accounts, before.counts.accounts);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a backup is listed as soon as it is taken, so recovery has something to pick", () => {
    const dir = mkdtempSync(join(tmpdir(), "budget-restore-"));
    try {
      const { db } = household(dir);
      createBackup(db, join(dir, "backups"));
      db.close();
      const found = listBackups(join(dir, "backups"));
      assert.equal(found.length, 1);
      assert.ok(found[0]!.bytes > 0);
      assert.ok(existsSync(found[0]!.path));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("SECURITY-OPS-22 · --force after a crash keeps the journal's writes in the replaced copy", () => {
    const dir = mkdtempSync(join(tmpdir(), "budget-restore-"));
    try {
      // The backup is taken, then the afternoon's work lands only in the -wal
      // (autocheckpoint off), and the process dies with the journal still hot:
      // the three files are copied while the connection is open, as a crash
      // leaves them.
      const hot = household(join(dir, "hot"));
      hot.db.exec("PRAGMA wal_autocheckpoint = 0");
      createBackup(hot.db, join(dir, "backups"));
      const account = queryAll<{ id: string }>(hot.db, `SELECT id FROM accounts LIMIT 1`)[0]!.id;
      for (let i = 0; i < 50; i++) {
        createTransaction(hot.db, actor, {
          accountId: account, amount: -rupees(100 + i), date: "2026-09-06", payeeName: `After ${i}`,
        });
      }
      const expected = controlTotals(hot.db);
      const live = join(dir, "pathayam.sqlite");
      copyFileSync(hot.path, live);
      copyFileSync(`${hot.path}-wal`, `${live}-wal`);
      copyFileSync(`${hot.path}-shm`, `${live}-shm`);
      hot.db.close();

      const run = spawnSync(process.execPath, [
        "--experimental-strip-types", "--no-warnings",
        join(import.meta.dirname, "..", "restore.ts"), "--latest", "--force",
      ], {
        env: { ...process.env, DATA_DIR: dir, DATABASE_PATH: live, BACKUP_DIR: join(dir, "backups") },
        encoding: "utf8",
      });
      assert.equal(run.status, 0, run.stderr);

      const kept = readdirSync(dir).filter((f) => f.startsWith("pathayam.sqlite.replaced-"));
      assert.deepEqual(kept.filter((f) => !f.endsWith("-wal") && !f.endsWith("-shm")).length, 1);
      assert.equal(kept.length, 1, "the journal was folded in, so the kept copy stands alone");
      assert.ok(!existsSync(`${live}-wal`), "the live database starts without a stale journal");

      // The kept copy still holds the writes that were only in the journal.
      const reopened = openDatabase({ path: join(dir, kept[0]!), verbose: false });
      const totals = controlTotals(reopened);
      reopened.close();
      assert.equal(totals.counts.transactions, expected.counts.transactions);
      assert.equal(totals.transactionTotal, expected.transactionTotal);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the restore script is shipped, since the runbook points at it", () => {
    // B51's lesson in miniature: a documented recovery step that does not exist
    // is worse than none, because it is only discovered during a recovery.
    const root = join(import.meta.dirname, "..");
    assert.ok(
      readdirSync(root).includes("restore.ts"),
      "src/restore.ts is referenced by README's recovery section",
    );
  });
});
