/**
 * `04` §3.2 · Saved import mapping profiles.
 *
 * "Profiles are saved, named, auto-detected on subsequent imports by header
 * signature." That last part is what makes J6 true — the second month's import
 * needs almost no work, because the app already knows what HDFC's columns mean.
 *
 * The guiding rule is the one at the end of §3.2: **an unrecognised file is a
 * mapping task, not an error.** Nothing here throws at the user; it either
 * recognises the file, or hands back the raw rows and asks.
 */

import type { DB } from "../db/db.ts";
import { newId, transact, queryAll, queryOne, execute } from "../db/db.ts";
import { appendEvent, type Actor } from "../core/events.ts";
import { nowIST } from "../core/dates.ts";
import {
  parseDelimited, detectDelimiter, guessMapping, applyMapping, headerSignature,
  type ColumnMapping, type ParseResult,
} from "./csv.ts";

export interface ImportProfile {
  id: string;
  name: string;
  account_id: string | null;
  header_signature: string | null;
  mapping: ColumnMapping;
  last_used_at: string | null;
}

export function listProfiles(db: DB): ImportProfile[] {
  return queryAll<{
    id: string; name: string; account_id: string | null;
    header_signature: string | null; mapping_json: string; last_used_at: string | null;
  }>(db, `SELECT * FROM import_profiles ORDER BY last_used_at DESC, name`).map((r) => ({
    id: r.id,
    name: r.name,
    account_id: r.account_id,
    header_signature: r.header_signature,
    mapping: JSON.parse(r.mapping_json) as ColumnMapping,
    last_used_at: r.last_used_at,
  }));
}

export function saveProfile(
  db: DB, actor: Actor,
  input: { name: string; accountId?: string | null; headers: string[]; mapping: ColumnMapping },
): ImportProfile {
  return transact(db, () => {
    const signature = headerSignature(input.headers);

    // One profile per (signature, account): re-importing the same bank's file
    // should update the mapping rather than accumulate near-duplicates the
    // user then has to choose between.
    const existing = queryOne<{ id: string }>(
      db,
      `SELECT id FROM import_profiles WHERE header_signature = ?
        AND (account_id IS ? OR account_id = ?)`,
      signature, input.accountId ?? null, input.accountId ?? null,
    );

    const id = existing?.id ?? newId();
    if (existing) {
      execute(
        db, `UPDATE import_profiles SET name = ?, mapping_json = ? WHERE id = ?`,
        input.name, JSON.stringify(input.mapping), id,
      );
    } else {
      execute(
        db,
        `INSERT INTO import_profiles (id,name,account_id,header_signature,mapping_json,created_at)
         VALUES (?,?,?,?,?,?)`,
        id, input.name, input.accountId ?? null, signature,
        JSON.stringify(input.mapping), nowIST(),
      );
    }

    appendEvent(db, actor, {
      entity: "import-profile", entityId: id, action: existing ? "update" : "create",
      after: { name: input.name, signature },
      summary: existing
        ? `Updated the "${input.name}" import mapping`
        : `Saved a "${input.name}" import mapping — the next file like this needs no setup`,
    });

    return listProfiles(db).find((p) => p.id === id)!;
  });
}

export function markProfileUsed(db: DB, id: string): void {
  execute(db, `UPDATE import_profiles SET last_used_at = ? WHERE id = ?`, nowIST(), id);
}

export function deleteProfile(db: DB, actor: Actor, id: string): void {
  transact(db, () => {
    const profile = listProfiles(db).find((p) => p.id === id);
    execute(db, `DELETE FROM import_profiles WHERE id = ?`, id);
    appendEvent(db, actor, {
      entity: "import-profile", entityId: id, action: "delete",
      summary: `Removed the "${profile?.name ?? "unnamed"}" import mapping`,
    });
  });
}

// ---------------------------------------------------------------------------
// Recognising a file
// ---------------------------------------------------------------------------

export type Recognition =
  | { kind: "profile"; profile: ImportProfile; headers: string[]; rows: string[][] }
  | { kind: "guessed"; mapping: ColumnMapping; headers: string[]; rows: string[][] }
  | { kind: "unknown"; rows: string[][] };

/**
 * `04` §3.2 · Work out what a file is, in the order that gets the user to a
 * result fastest: a saved profile, then a guess, then the raw rows.
 *
 * `unknown` is not a failure. It is the state the mapping UI exists for.
 */
export function recognise(db: DB, text: string, accountId?: string | null): Recognition {
  const rows = parseDelimited(text, detectDelimiter(text));

  // A saved profile knows which row the headers are on, so try it first —
  // some statements carry account details above the table.
  for (const profile of listProfiles(db)) {
    if (!profile.header_signature) continue;
    if (accountId && profile.account_id && profile.account_id !== accountId) continue;

    const headerRow = rows[profile.mapping.headerRow];
    if (!headerRow) continue;
    if (headerSignature(headerRow) !== profile.header_signature) continue;

    return { kind: "profile", profile, headers: headerRow, rows };
  }

  const guessed = guessMapping(rows);
  if (guessed) {
    return { kind: "guessed", mapping: guessed, headers: rows[guessed.headerRow] ?? [], rows };
  }

  return { kind: "unknown", rows };
}

export function parseWith(rows: string[][], mapping: ColumnMapping): ParseResult {
  return applyMapping(rows, mapping);
}

/**
 * Candidate column names for the mapping UI, so the user picks from what is
 * actually in the file rather than typing an index.
 */
export function columnChoices(rows: string[][], headerRow: number): { index: number; label: string; sample: string }[] {
  const headers = rows[headerRow] ?? [];
  const firstData = rows.slice(headerRow + 1).find((r) => r.some((c) => c.trim() !== "")) ?? [];

  return headers.map((header, index) => ({
    index,
    label: header.trim() || `Column ${index + 1}`,
    sample: (firstData[index] ?? "").trim(),
  }));
}

/**
 * B64 · Is there a table here at all?
 *
 * `04` §3.2 treats a file this app cannot read as a mapping task rather than an
 * error — the user points at the columns and the profile is reused forever
 * after. That only helps when there *are* columns. A scanned statement is an
 * image with no text layer, so extraction yields nothing, and the mapping
 * screen would offer "Column 1" for every field above an empty table.
 *
 * Two rows with two columns between them is the least that could be mapped:
 * one header and one row of data.
 */
export function looksMappable(rows: string[][]): boolean {
  const populated = rows.filter((row) => row.some((cell) => cell.trim() !== ""));
  if (populated.length < 2) return false;
  return populated.some((row) => row.filter((cell) => cell.trim() !== "").length >= 2);
}

/**
 * Rows that look like they might be the header, for a file where the guess
 * failed. Offered in the mapping UI so the user points at the right one rather
 * than counting lines.
 */
export function candidateHeaderRows(rows: string[][], limit = 25): { index: number; cells: string[] }[] {
  return rows
    .slice(0, limit)
    .map((cells, index) => ({ index, cells }))
    .filter((row) => row.cells.filter((c) => c.trim() !== "").length >= 3);
}

/** Build a mapping from what the user picked in the form. */
export function mappingFromSelections(input: {
  headerRow: number;
  date: number;
  narration: number;
  amount?: number | null;
  debit?: number | null;
  credit?: number | null;
  balance?: number | null;
  reference?: number | null;
}): ColumnMapping {
  const mapping: ColumnMapping = {
    headerRow: input.headerRow,
    date: input.date,
    narration: input.narration,
  };

  // Separate debit/credit columns take precedence: most Indian statements use
  // them, and a file with both plus a signed column means the pair.
  if (input.debit != null && input.debit >= 0 && input.credit != null && input.credit >= 0) {
    mapping.debit = input.debit;
    mapping.credit = input.credit;
  } else if (input.amount != null && input.amount >= 0) {
    mapping.amount = input.amount;
  }

  if (input.balance != null && input.balance >= 0) mapping.balance = input.balance;
  if (input.reference != null && input.reference >= 0) mapping.reference = input.reference;

  return mapping;
}

/** Whether a mapping can actually produce records, and why not if it cannot. */
export function validateMapping(mapping: ColumnMapping): string | null {
  if (mapping.date < 0) return "Pick which column holds the date.";
  if (mapping.narration < 0) return "Pick which column holds the description.";
  if (mapping.amount === undefined && (mapping.debit === undefined || mapping.credit === undefined)) {
    return "Pick either a single amount column, or both a debit and a credit column.";
  }
  return null;
}
