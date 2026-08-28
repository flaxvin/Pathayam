import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, ensureHousehold, execute, type DB } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST, todayIST } from "../core/dates.ts";
import { rupees } from "../core/money.ts";
import { createAssetAccount, findOrCreateInstrument, recordPurchase, recordPrice } from "../domain/assets.ts";
import { units, price } from "../portfolio/holdings.ts";
import { createBackup, verifyRestore, controlTotals, exportEverything } from "./backup.ts";

const RAVI = "m-ravi";
const actor: Actor = { memberId: RAVI, source: "ui" };

function setup(dir: string): DB {
  const db = openDatabase({ path: join(dir, "live.sqlite"), verbose: false });
  ensureHousehold(db);
  execute(db, `INSERT INTO members (id,email,name,created_at) VALUES (?,?,?,?)`,
    RAVI, "ravi@example.com", "Ravi", nowIST());
  const demat = createAssetAccount(db, actor, { name: "Zerodha", subtype: "investment" });
  const inst = findOrCreateInstrument(db, actor, { name: "Nifty ETF", kind: "etf", provider: "manual" });
  recordPurchase(db, actor, {
    accountId: demat.id, instrumentId: inst.id, tradeDate: "2026-08-01",
    price: price(200), units: units(100),
  });
  recordPrice(db, { instrumentId: inst.id, price: price(220), asOf: todayIST(), source: "test" });
  return db;
}

describe("R40.2 / F15 · the portfolio is covered by backup and export", () => {
  test("holdings, lots and instruments are counted in control totals", () => {
    const dir = mkdtempSync(join(tmpdir(), "cov-"));
    const db = setup(dir);
    const totals = controlTotals(db);

    assert.equal(totals.counts.instruments, 1);
    assert.equal(totals.counts.holdings, 1);
    assert.equal(totals.counts.lots, 1);
    assert.equal(totals.lotUnitsTotal, 100_000, "milliunits are summed");
    assert.equal(totals.lotCostTotal, rupees(20_000));

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a restore that silently drops every lot FAILS verification", () => {
    const dir = mkdtempSync(join(tmpdir(), "cov-"));
    const db = setup(dir);
    const backupDir = join(dir, "backups");
    createBackup(db, backupDir);

    // Before this fix the lots table was invisible to verification, so wiping
    // the live portfolio would still "match". Now the row-count check catches
    // it (the backup has more lot rows than live).
    execute(db, `DELETE FROM lots`);

    const result = verifyRestore(db, backupDir);
    assert.equal(result.ok, false);
    assert.ok(result.mismatches.some((m) => m.includes("lots")), result.mismatches.join("; "));

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("the export carries the portfolio", () => {
    const dir = mkdtempSync(join(tmpdir(), "cov-"));
    const db = setup(dir);
    const exported = exportEverything(db) as { data: Record<string, unknown[]> };

    assert.equal(exported.data.instruments!.length, 1);
    assert.equal(exported.data.holdings!.length, 1);
    assert.equal(exported.data.lots!.length, 1);
    assert.equal(exported.data.prices!.length, 1);

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("secrets and ephemeral tables are NOT in the export", () => {
    const dir = mkdtempSync(join(tmpdir(), "cov-"));
    const db = setup(dir);
    const exported = exportEverything(db) as { data: Record<string, unknown> };

    for (const table of [
      "statement_identity", "gmail_connections", "sessions", "api_tokens",
      "auth_attempts", "idempotency_keys", "job_runs", "price_fetches",
    ]) {
      assert.ok(!(table in exported.data), `${table} must not be exported`);
    }

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
