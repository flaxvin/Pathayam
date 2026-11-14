/**
 * WEB-4 · The database, a backup and an export are the owner's alone, whatever
 * the umask.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, ensureHousehold } from "../db/db.ts";
import { createBackup, writeExport } from "./backup.ts";

const mode = (path: string) => statSync(path).mode & 0o777;

test("WEB-4 · new database, backup folder, backup and export are owner-only", () => {
  const root = mkdtempSync(join(tmpdir(), "pathayam-modes-"));
  const previous = process.umask(0o022);
  try {
    const dbPath = join(root, "data", "budget.sqlite");
    const db = openDatabase({ path: dbPath, verbose: false });
    ensureHousehold(db);
    assert.equal(mode(join(root, "data")), 0o700);
    assert.equal(mode(dbPath), 0o600);
    assert.equal(mode(`${dbPath}-wal`), 0o600);

    const dir = join(root, "backups");
    const backup = createBackup(db, dir);
    assert.equal(mode(dir), 0o700);
    assert.equal(mode(backup.path), 0o600);

    const exported = writeExport(db, join(root, "export.json"));
    assert.equal(mode(exported.path), 0o600);
    db.close();

    // A database that already exists keeps the mode its operator gave it.
    const existing = join(root, "existing.sqlite");
    writeFileSync(existing, "");
    chmodSync(existing, 0o640);
    openDatabase({ path: existing, verbose: false }).close();
    assert.equal(mode(existing), 0o640);
  } finally {
    process.umask(previous);
    rmSync(root, { recursive: true, force: true });
  }
});
