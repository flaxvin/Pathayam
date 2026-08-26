import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDatabase, ensureHousehold, execute, type DB } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import { createAccount } from "../domain/accounts.ts";
import { createGroup, createCategory, setAssigned } from "../domain/budget.ts";
import { createTransaction } from "../domain/transactions.ts";
import {
  createBackup, listBackups, pruneBackups, controlTotals, verifyRestore,
  runBackupJob, reportFailure, exportEverything, exportTransactionsCsv, lastJobRun,
  pingHeartbeat,
} from "./backup.ts";

const RAVI = "m-ravi";
const actor: Actor = { memberId: RAVI, source: "ui" };

function setup(dir: string): { db: DB; accountId: string } {
  const db = openDatabase({ path: join(dir, "live.sqlite"), verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    RAVI, "ravi@example.com", "Ravi", nowIST());

  const account = createAccount(db, actor, {
    name: "HDFC Savings", kind: "budget", subtype: "savings",
    openingBalance: rupees(100_000), openingDate: "2026-08-01",
  });
  const group = createGroup(db, actor, "Flexible");
  const groceries = createCategory(db, actor, { groupId: group.id, name: "Groceries" });
  setAssigned(db, actor, "2026-08", groceries.id, rupees(12_000));
  createTransaction(db, actor, {
    accountId: account.id, amount: rupees(-1_450), date: "2026-08-10",
    categoryId: groceries.id, payeeName: "DMart",
  });

  return { db, accountId: account.id };
}

/**
 * A path that cannot become a directory, because its parent is a file. Used to
 * force a backup failure deterministically — an unwritable path would depend
 * on the uid, and the tests run as root inside the container.
 */
function unwritablePath(dir: string): string {
  const blocker = join(dir, "blocker");
  writeFileSync(blocker, "not a directory");
  return join(blocker, "backups");
}

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "budget-backup-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("R40.1 · taking a backup", () => {
  test("writes a plain SQLite file readable without this application (R40.7)", () => {
    withTempDir((dir) => {
      const { db } = setup(dir);
      const backup = createBackup(db, join(dir, "backups"));

      assert.ok(backup.bytes > 0);
      assert.match(backup.path, /\.sqlite$/);

      // Opened by a bare sqlite driver with no knowledge of the app.
      const raw = new DatabaseSync(backup.path, { readOnly: true });
      const rows = raw.prepare(`SELECT COUNT(*) AS n FROM transactions`).get() as { n: number };
      assert.equal(rows.n, 1);
      raw.close();
      db.close();
    });
  });

  test("captures the event log, which the export and replay depend on (R37.5)", () => {
    withTempDir((dir) => {
      const { db } = setup(dir);
      const backup = createBackup(db, join(dir, "backups"));
      assert.ok(backup.totals.eventCount > 0);

      const raw = new DatabaseSync(backup.path, { readOnly: true });
      const events = raw.prepare(`SELECT COUNT(*) AS n FROM events`).get() as { n: number };
      assert.equal(events.n, backup.totals.eventCount);
      raw.close();
      db.close();
    });
  });

  test("prunes old backups but keeps the most recent", () => {
    withTempDir((dir) => {
      const { db } = setup(dir);
      const backupDir = join(dir, "backups");
      for (let i = 0; i < 5; i++) {
        createBackup(db, backupDir, new Date(Date.UTC(2026, 7, 20 + i, 3, 0, 0)));
      }
      assert.equal(listBackups(backupDir).length, 5);
      assert.equal(pruneBackups(backupDir, 2), 3);
      assert.equal(listBackups(backupDir).length, 2);
      db.close();
    });
  });
});

describe("R40.2 · verified restore", () => {
  test("matches every control total on a faithful backup", () => {
    withTempDir((dir) => {
      const { db } = setup(dir);
      const backupDir = join(dir, "backups");
      createBackup(db, backupDir);

      const result = verifyRestore(db, backupDir);
      assert.equal(result.ok, true, result.summary);
      assert.deepEqual(result.mismatches, []);
      assert.ok(result.entitiesChecked >= 14);
      // R40.3's wording, ready for the health page.
      assert.match(result.summary, /all control totals matched/);
      db.close();
    });
  });

  test("says so plainly when there is no backup to restore", () => {
    withTempDir((dir) => {
      const { db } = setup(dir);
      const result = verifyRestore(db, join(dir, "backups"));
      assert.equal(result.ok, false);
      assert.match(result.summary, /No backup found/);
      db.close();
    });
  });

  test("fails loudly on a corrupt backup rather than reporting success", () => {
    withTempDir((dir) => {
      const { db } = setup(dir);
      const backupDir = join(dir, "backups");
      createBackup(db, backupDir);

      // 08 §12: a failed restore verification is the one failure where a quiet
      // log line is negligence.
      const path = listBackups(backupDir)[0]!.path;
      writeFileSync(path, "this is not a database at all");

      const result = verifyRestore(db, backupDir);
      assert.equal(result.ok, false);
      assert.ok(result.mismatches.length > 0);
      db.close();
    });
  });

  test("catches a backup holding rows the live database does not", () => {
    withTempDir((dir) => {
      const { db, accountId } = setup(dir);
      const backupDir = join(dir, "backups");
      createBackup(db, backupDir);

      // Deleting from live afterwards means the backup now has more rows.
      // That is exactly the shape of a restore that would resurrect data, and
      // it must not be reported as a match.
      execute(db, `DELETE FROM transactions`);
      const result = verifyRestore(db, backupDir);
      assert.equal(result.ok, false);
      assert.ok(result.mismatches.some((m) => m.includes("transactions")));
      void accountId;
      db.close();
    });
  });

  test("tolerates writes made after the snapshot", () => {
    withTempDir((dir) => {
      const { db, accountId } = setup(dir);
      const backupDir = join(dir, "backups");
      createBackup(db, backupDir);

      // A backup is a point in time; later writes are normal, not a fault.
      createTransaction(db, actor, {
        accountId, amount: rupees(-500), date: "2026-08-20",
      });

      const result = verifyRestore(db, backupDir);
      assert.equal(result.ok, true, result.summary);
      db.close();
    });
  });

  test("R40.5 — verification never writes to the live database", () => {
    withTempDir((dir) => {
      const { db } = setup(dir);
      const backupDir = join(dir, "backups");
      createBackup(db, backupDir);

      const before = controlTotals(db);
      verifyRestore(db, backupDir);
      assert.deepEqual(controlTotals(db), before);
      db.close();
    });
  });
});

describe("R40.4 · alerting on failure", () => {
  test("posts to the configured webhook when verification fails", async () => {
    await withTempDir(async (dir) => {
      const { db } = setup(dir);

      const calls: { url: string; body: unknown }[] = [];
      const fakeFetch = (async (url: unknown, init?: { body?: string }) => {
        calls.push({ url: String(url), body: JSON.parse(init?.body ?? "{}") });
        return { ok: true } as Response;
      }) as unknown as typeof fetch;

      // The backup cannot even be written, so the job must fail and alert.
      const result = await runBackupJob(db, {
        backupDir: unwritablePath(dir),
        webhookUrl: "https://hooks.example/budget",
        fetchImpl: fakeFetch,
      });

      assert.equal(result.ok, false);
      assert.equal(calls.length, 1);
      assert.equal((calls[0]!.body as { event: string }).event, "restore-verification-failed");
      db.close();
    });
  });

  test("stays silent when everything is fine — Q24 narrowed alerts to this one class", async () => {
    await withTempDir(async (dir) => {
      const { db } = setup(dir);
      let called = 0;
      const fakeFetch = (async () => {
        called++;
        return { ok: true } as Response;
      }) as unknown as typeof fetch;

      const result = await runBackupJob(db, {
        backupDir: join(dir, "backups"),
        webhookUrl: "https://hooks.example/budget",
        fetchImpl: fakeFetch,
      });

      assert.equal(result.ok, true, result.summary);
      assert.equal(called, 0, "a healthy run is reported on the health page, not by webhook");
      db.close();
    });
  });

  test("does nothing when no webhook is configured", async () => {
    const result = await reportFailure(null, {
      ok: false, at: nowIST(), backupPath: null, entitiesChecked: 0,
      mismatches: [], live: null, restored: null, summary: "x",
    });
    assert.equal(result, false);
  });

  test("a webhook that is unreachable does not throw and lose the job", async () => {
    const fakeFetch = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;

    const result = await reportFailure(
      "https://hooks.example/budget",
      {
        ok: false, at: nowIST(), backupPath: null, entitiesChecked: 0,
        mismatches: ["x"], live: null, restored: null, summary: "x",
      },
      fakeFetch,
    );
    assert.equal(result, false);
  });
});

describe("F27 · what the health page reads", () => {
  test("records each job run with its outcome", async () => {
    await withTempDir(async (dir) => {
      const { db } = setup(dir);
      await runBackupJob(db, { backupDir: join(dir, "backups"), webhookUrl: null });

      assert.equal(lastJobRun(db, "backup").status, "ok");
      const verification = lastJobRun(db, "restore-verification");
      assert.equal(verification.status, "ok");
      assert.match(verification.detail!, /all control totals matched/);
      db.close();
    });
  });
});

describe("F15 · export", () => {
  test("carries every entity, the event log and its own documentation", () => {
    withTempDir((dir) => {
      const { db } = setup(dir);
      const exported = exportEverything(db) as {
        format: string;
        data: Record<string, unknown[]>;
        notes: Record<string, string>;
        controlTotals: { transactionTotal: number };
      };

      assert.equal(exported.format, "budget-app-export");
      assert.equal(exported.data.transactions!.length, 1);
      assert.equal(exported.data.assignments!.length, 1);
      assert.ok(exported.data.events!.length > 0, "R37.5 — the log is included");
      // R40.7: the file explains itself without this codebase to hand.
      assert.match(exported.notes.amounts!, /paise/);
      assert.equal(exported.controlTotals.transactionTotal, rupees(-1_450));
      db.close();
    });
  });

  test("CSV keeps the raw imported values (F15.3, P4)", () => {
    withTempDir((dir) => {
      const { db, accountId } = setup(dir);
      createTransaction(db, actor, {
        accountId, amount: rupees(-450), date: "2026-08-14", payeeName: "Swiggy",
        raw: { narration: "UPI/P2M/431202847592/SWIGGY*ORDER", amount: "450.00" },
      });

      const csv = exportTransactionsCsv(db);
      assert.match(csv.split("\n")[0]!, /raw_narration/);
      assert.match(csv, /UPI\/P2M\/431202847592\/SWIGGY\*ORDER/);
      db.close();
    });
  });

  test("CSV escapes a memo containing a comma", () => {
    withTempDir((dir) => {
      const { db, accountId } = setup(dir);
      createTransaction(db, actor, {
        accountId, amount: rupees(-100), date: "2026-08-15",
        memo: 'milk, bread and "eggs"',
      });
      const csv = exportTransactionsCsv(db);
      assert.match(csv, /"milk, bread and ""eggs"""/);
      db.close();
    });
  });
});

describe("R40.8 · the dead-man's switch", () => {
  test("pings the monitor on a successful verified restore", async () => {
    await withTempDir(async (dir) => {
      const { db } = setup(dir);
      const pings: string[] = [];
      const fakeFetch = (async (url: unknown) => {
        pings.push(String(url));
        return { ok: true } as Response;
      }) as unknown as typeof fetch;

      const result = await runBackupJob(db, {
        backupDir: join(dir, "backups"),
        webhookUrl: null,
        heartbeatUrl: "https://hc.example/abc",
        fetchImpl: fakeFetch,
      });

      assert.equal(result.ok, true, result.summary);
      assert.deepEqual(pings, ["https://hc.example/abc"]);
      assert.equal(lastJobRun(db, "heartbeat").status, "ok");
      db.close();
    });
  });

  test("stays silent when the job fails — silence is the alert", async () => {
    await withTempDir(async (dir) => {
      const { db } = setup(dir);

      const heartbeats: string[] = [];
      const webhooks: string[] = [];
      const fakeFetch = (async (url: unknown, init?: { method?: string; body?: string }) => {
        (init?.body ? webhooks : heartbeats).push(String(url));
        return { ok: true } as Response;
      }) as unknown as typeof fetch;

      // The job cannot even take a snapshot.
      const result = await runBackupJob(db, {
        backupDir: unwritablePath(dir),
        webhookUrl: "https://hooks.example/budget",
        heartbeatUrl: "https://hc.example/abc",
        fetchImpl: fakeFetch,
      });

      assert.equal(result.ok, false);
      // Pinging on a failed run would tell the monitor everything is fine,
      // which is the exact opposite of what R40.8 is for.
      assert.deepEqual(heartbeats, [], "no heartbeat on a failed run");
      assert.equal(webhooks.length, 1, "the box is still up, so R40.4 can report it");
      db.close();
    });
  });

  test("an unreachable monitor does not fail the job", async () => {
    await withTempDir(async (dir) => {
      const { db } = setup(dir);
      const fakeFetch = (async () => {
        throw new Error("network unreachable");
      }) as unknown as typeof fetch;

      const result = await runBackupJob(db, {
        backupDir: join(dir, "backups"),
        webhookUrl: null,
        heartbeatUrl: "https://hc.example/abc",
        fetchImpl: fakeFetch,
      });

      assert.equal(result.ok, true, "the restore verified; only the ping failed");
      const beat = lastJobRun(db, "heartbeat");
      assert.equal(beat.status, "failed");
      assert.match(beat.detail!, /alert on the missing ping/);
      db.close();
    });
  });

  test("records that no monitor is configured, rather than reporting success", async () => {
    await withTempDir(async (dir) => {
      const { db } = setup(dir);
      await runBackupJob(db, { backupDir: join(dir, "backups"), webhookUrl: null });
      assert.equal(lastJobRun(db, "heartbeat").status, "skipped");
      db.close();
    });
  });

  test("pingHeartbeat does nothing without a URL", async () => {
    const beat = await pingHeartbeat(null);
    assert.equal(beat.ok, false);
  });
});
