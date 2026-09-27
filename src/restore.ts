/**
 * R40 · Restore a backup, on the day it matters.
 *
 * The app has taken backups and proved nightly that it *could* restore them
 * since early on. It never said how to actually do it — and the obvious way is
 * a trap.
 *
 * SQLite in WAL mode keeps two sidecar files next to the database. Copying a
 * backup over `pathayam.sqlite` while a stale `-wal` and `-shm` remain leaves
 * SQLite holding a fresh database and one crashed instance's journal, and the
 * first query answers:
 *
 *     database disk image is malformed
 *
 * Which is what a household would meet at the worst possible moment, having
 * done the sensible thing. After a crash — the case where a restore is actually
 * needed — those files are always present.
 *
 *   node --experimental-strip-types src/restore.ts --list
 *   node --experimental-strip-types src/restore.ts --latest
 *   node --experimental-strip-types src/restore.ts backups/budget-2026-09-11....sqlite
 *
 * It refuses to run against a database something else has open, keeps what it
 * replaced, and reads the restored copy back before reporting success.
 */

import { copyFileSync, existsSync, rmSync, renameSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "./config.ts";
import { openDatabase } from "./db/db.ts";
import { listBackups, controlTotals } from "./ops/backup.ts";
import { formatPaise } from "./core/money.ts";

const SIDECARS = ["-wal", "-shm"];

function fail(message: string): never {
  console.error(`\n${message}\n`);
  process.exit(1);
}

function describe(path: string): string {
  const { size, mtime } = statSync(path);
  return `${path.split("/").pop()}  ${(size / 1024).toFixed(0)} KB  ${mtime.toISOString().slice(0, 16).replace("T", " ")}`;
}

function main(): void {
  const config = loadConfig();
  const args = process.argv.slice(2);
  const backups = listBackups(config.backupDir);

  if (args.includes("--help") || args.length === 0) {
    console.log(
      `\nRestore a backup over the live database.\n\n` +
      `  --list            show what is available\n` +
      `  --latest          restore the most recent backup\n` +
      `  <path>            restore a specific file\n\n` +
      `The live database is kept as <database>.replaced-<timestamp> either way.\n` +
      `Stop the app first.\n`,
    );
    return;
  }

  if (args.includes("--list")) {
    if (backups.length === 0) fail(`No backups in ${config.backupDir}.`);
    console.log(`\n${backups.length} backup(s) in ${config.backupDir}:\n`);
    for (const b of backups) console.log(`  ${describe(b.path)}`);
    console.log();
    return;
  }

  const chosen = args.includes("--latest") ? backups[0]?.path : args.find((a) => !a.startsWith("--"));
  if (!chosen) fail("Nothing to restore. Pass --latest or a path, or --list to see what there is.");
  if (!existsSync(chosen)) fail(`No such file: ${chosen}`);

  /*
   * A running instance holds the WAL open, and replacing the file underneath it
   * is how one bad afternoon becomes two. This is a weak check — it only sees
   * the sidecars — but it catches the common mistake, and the cost of being
   * wrong here is the whole ledger.
   */
  const live = config.databasePath;
  if (existsSync(`${live}-wal`) && statSync(`${live}-wal`).size > 0) {
    console.warn(
      `\n⚠  ${live}-wal is not empty, which usually means the app is still running\n` +
      `   or was killed mid-write. Stop it first, then run this again.\n`,
    );
    if (!args.includes("--force")) {
      fail("Refusing to restore over a database that may still be open. Use --force to override.");
    }
  }

  /*
   * Keep what is being replaced. It may be the only copy of the last few hours.
   *
   * SECURITY-OPS-22 · After a crash those last few hours are not in the main
   * file at all: they are in the -wal, committed but not yet checkpointed. This
   * used to rename the main file and then delete the sidecars, which kept a
   * bare file that could not even be opened ("no such table") and threw away
   * exactly the writes the comment above promises to keep. So the sidecars now
   * move with it, under the names SQLite itself looks for (<kept>-wal), and the
   * kept copy is opened once so SQLite replays the journal into it and the
   * .replaced file stands on its own. If that open fails, nothing is lost — the
   * journal is still beside it — and the message says so.
   */
  if (existsSync(live)) {
    const kept = `${live}.replaced-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    renameSync(live, kept);
    for (const suffix of SIDECARS) {
      if (existsSync(`${live}${suffix}`)) renameSync(`${live}${suffix}`, `${kept}${suffix}`);
    }
    try {
      const old = new DatabaseSync(kept);
      old.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      old.close();
      for (const suffix of SIDECARS) rmSync(`${kept}${suffix}`, { force: true });
    } catch (error) {
      console.warn(
        `  could not fold the journal into the kept copy (${(error as Error).message});\n` +
        `  its -wal and -shm are kept beside it — do not separate them.`,
      );
    }
    console.log(`  kept the current database as ${kept.split("/").pop()}`);
  }
  // The whole point: a stale journal against a fresh database reads as corruption.
  // Any sidecar still here has no main file to belong to (the database was
  // already missing), so there is nothing of value in it to keep.
  for (const suffix of SIDECARS) rmSync(`${live}${suffix}`, { force: true });

  copyFileSync(chosen, live);
  console.log(`  restored ${chosen.split("/").pop()}`);

  // Read it back rather than trusting the copy. R40.2's whole argument is that
  // a backup nobody has opened is a hope, not a backup.
  const db = openDatabase({ path: live, verbose: false });
  const totals = controlTotals(db);
  db.close();

  console.log(
    `\n  ${totals.counts.transactions} transactions · ${totals.counts.accounts} accounts · ` +
    `${totals.counts.events} events\n` +
    `  transactions sum to ${formatPaise(totals.transactionTotal)}\n\n` +
    `  Start the app and check the health page.\n`,
  );
}

main();
