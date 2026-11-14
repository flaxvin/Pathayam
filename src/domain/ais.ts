/**
 * TAX-AIS · A member's Annual Information Statement, as figures, and what the
 * tax page does with them.
 *
 * Reading the PDF is `src/import/ais.ts`; this is the checking, the storage
 * and the arithmetic. Three rules shape it:
 *
 *   · **Only the member's own.** Everything is keyed by the member, the same
 *     as `tax_declarations`. There is no way to ask for another member's AIS,
 *     and an AIS whose PAN is not the member's saved PAN is refused.
 *   · **Figures, not the file.** What is kept per line is a category, the
 *     information description, the reporting bank or employer, the amount and
 *     the TDS. The PAN is read to check ownership and then dropped.
 *   · **It suggests; the form decides.** Nothing here writes the declaration.
 *     The page offers the AIS's TDS and income the way it offers policy
 *     premiums (INSURANCE-1): it raises a figure, never lowers one, and nothing
 *     is saved until the form is.
 */

import type { DB } from "../db/db.ts";
import { execute, queryAll, queryOne, newId } from "../db/db.ts";
import { nowIST, fiscalYearRange, formatFiscalYear } from "../core/dates.ts";
import type { Paise } from "../core/money.ts";
import { Refusal } from "../core/refusal.ts";
import { assertKnownYear } from "./tax.ts";
import { getIdentity } from "../import/identity.ts";
import type { AisCategory, AisLine, AisStatement } from "../import/ais.ts";
import { isClearlyTds } from "../import/ais.ts";

/** A PAN shown masked, the way the identity screen shows it. */
function maskPan(pan: string): string {
  return `${pan.slice(0, 4).toUpperCase()}••••${pan.slice(-2).toUpperCase()}`;
}

export interface AisCheck {
  /** Whether the file's PAN was compared with a saved one. */
  panChecked: boolean;
  /** Said on the page after the import; none of them stop it. */
  warnings: string[];
}

/**
 * Whether `statement` may be imported for `memberId` into `fy`.
 *
 * Refused: a year other than the one on screen (the member chose a year and
 * the file is another), a year the app has no slabs for (the same refusal the
 * page gives for that year, TAX-FY25-1), and a PAN that is not the member's
 * saved one. With no saved PAN, it is imported with a warning, since the app
 * has nothing to check it against.
 */
export function checkAis(db: DB, memberId: string, fy: number, statement: AisStatement): AisCheck {
  // The file's year first: sending somebody to a year with no slabs would
  // only end in this refusal there.
  assertKnownYear(statement.fy);
  if (statement.fy !== fy) {
    throw new Refusal(
      `That AIS is for ${formatFiscalYear(statement.fy)}, and this page is ${formatFiscalYear(fy)}. ` +
      `Switch to ${formatFiscalYear(statement.fy)} above and upload it there. Nothing was imported.`,
    );
  }

  const saved = getIdentity(db, memberId)?.pan ?? null;
  if (saved) {
    if (saved.trim().toUpperCase() !== statement.pan.toUpperCase()) {
      throw new Refusal(
        `That AIS is for PAN ${maskPan(statement.pan)}, not the PAN saved for you (${maskPan(saved)}). ` +
        "Each member imports their own AIS, signed in as themselves. Nothing was imported.",
      );
    }
    return { panChecked: true, warnings: [] };
  }
  return {
    panChecked: false,
    warnings: [
      `No PAN is saved for you, so this could not be checked as yours (it is for ${maskPan(statement.pan)}). ` +
      "Save your PAN in Settings, under opening statements without typing a password, and the next import will check it.",
    ],
  };
}

/**
 * Replace the member's AIS for the year with this one. Idempotent: the same
 * file twice leaves the same lines, never twice as many.
 */
export function replaceAis(
  db: DB, memberId: string, fy: number, statement: AisStatement, check: AisCheck,
): void {
  execute(db, `DELETE FROM ais_lines WHERE member_id = ? AND fy = ?`, memberId, fy);
  execute(
    db,
    `INSERT INTO ais_imports (member_id, fy, imported_at, pan_checked, not_read) VALUES (?,?,?,?,?)
     ON CONFLICT (member_id, fy) DO UPDATE SET
       imported_at = excluded.imported_at, pan_checked = excluded.pan_checked, not_read = excluded.not_read`,
    memberId, fy, nowIST(), check.panChecked ? 1 : 0, JSON.stringify(statement.notRead),
  );
  for (const line of statement.lines) {
    execute(
      db,
      `INSERT INTO ais_lines (id, member_id, fy, section, category, code, label, source, amount, tds)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      newId(), memberId, fy, line.section, line.category, line.code, line.label, line.source,
      line.amount, line.tds,
    );
  }
}

/** Forget the member's AIS for the year. Their own only, by construction. */
export function deleteAis(db: DB, memberId: string, fy: number): boolean {
  execute(db, `DELETE FROM ais_lines WHERE member_id = ? AND fy = ?`, memberId, fy);
  return execute(db, `DELETE FROM ais_imports WHERE member_id = ? AND fy = ?`, memberId, fy) > 0;
}

export interface AisSourceTotal { source: string; amount: Paise; tds: Paise }

export interface AisSummary {
  fy: number;
  importedAt: string;
  panChecked: boolean;
  notRead: { part: string; lines: number }[];
  /** TDS by deductor, largest first. */
  tdsBySource: AisSourceTotal[];
  tdsTotal: Paise;
  /** Income by kind, after the per-source de-duplication below. */
  salary: Paise;
  interestSavings: Paise;
  interestDeposit: Paise;
  interestOther: Paise;
  dividends: Paise;
  /** Sale value of securities and fund units, as reported. Information only. */
  securitiesSold: Paise;
  /**
   * What the app recorded as sale proceeds for this member's own holdings in
   * the year, in rupee-priced instruments — the reconciliation hint beside
   * `securitiesSold`. The app's gains engine stays the source for gains.
   */
  appSaleProceeds: Paise;
  /** Lines of a category the estimate does not use, kept so the page can list them. */
  unread: { label: string; source: string; amount: Paise }[];
  /** Salary + interest + dividends: what the gross income is raised to, at least. */
  incomeOffer: Paise;
}

interface Row {
  section: AisLine["section"]; category: AisCategory; code: string | null;
  label: string; source: string; amount: number; tds: number;
}

/** "STATE BANK OF INDIA (MUMS12345A)" and "State Bank of India" are one source. */
function sourceKey(source: string): string {
  return source.replace(/\([^)]*\)/g, "").replace(/[^A-Za-z0-9]+/g, " ").trim().toUpperCase();
}

/**
 * The member's AIS for the year, summarised, or null when none is imported.
 *
 * Income is de-duplicated per source and category: the same interest can be
 * reported twice, once by the bank's TDS return and once in its SFT, and the
 * department's Handbook (§4.3, §4.5) keeps the higher value per reporting
 * entity and marks the lower a duplicate. This does the same — the higher of
 * the TDS-side and SFT-side amount for one source — rather than adding both.
 * Whether a printed PDF already omits the duplicate is [unverified]; taking
 * the higher of two is right either way.
 */
export function aisSummary(db: DB, memberId: string, fy: number): AisSummary | null {
  const head = queryOne<{ imported_at: string; pan_checked: number; not_read: string }>(
    db, `SELECT imported_at, pan_checked, not_read FROM ais_imports WHERE member_id = ? AND fy = ?`, memberId, fy,
  );
  if (!head) return null;
  const rows = queryAll<Row>(
    db,
    `SELECT section, category, code, label, source, amount, tds
       FROM ais_lines WHERE member_id = ? AND fy = ? ORDER BY rowid`,
    memberId, fy,
  );

  const tds = new Map<string, AisSourceTotal>();
  for (const r of rows) {
    // Rows stored before review 2 may carry TCS or an uncategorised line's
    // figure in tds; neither is offered to the TDS box.
    if (r.tds <= 0 || !isClearlyTds(r)) continue;
    const key = sourceKey(r.source);
    const t = tds.get(key) ?? { source: r.source, amount: 0 as Paise, tds: 0 as Paise };
    t.amount = (t.amount + r.amount) as Paise;
    t.tds = (t.tds + r.tds) as Paise;
    tds.set(key, t);
  }
  const tdsBySource = [...tds.values()].sort((a, b) => b.tds - a.tds);

  // Per category, per source, per section; then the higher section per source.
  const income = (category: AisCategory): Paise => {
    const bySource = new Map<string, Map<string, number>>();
    for (const r of rows.filter((x) => x.category === category)) {
      const key = sourceKey(r.source);
      const sections = bySource.get(key) ?? new Map<string, number>();
      sections.set(r.section, (sections.get(r.section) ?? 0) + r.amount);
      bySource.set(key, sections);
    }
    let total = 0;
    for (const sections of bySource.values()) total += Math.max(...sections.values());
    return total as Paise;
  };

  let notRead: { part: string; lines: number }[] = [];
  try {
    const parsed = JSON.parse(head.not_read) as unknown;
    if (Array.isArray(parsed)) {
      notRead = parsed.filter((x): x is { part: string; lines: number } =>
        !!x && typeof x.part === "string" && typeof x.lines === "number");
    }
  } catch { /* an unreadable note is no note */ }

  const salary = income("salary");
  const interestSavings = income("interest-savings");
  const interestDeposit = income("interest-deposit");
  const interestOther = income("interest-other");
  const dividends = income("dividend");

  return {
    fy,
    importedAt: head.imported_at,
    panChecked: head.pan_checked === 1,
    notRead,
    tdsBySource,
    tdsTotal: tdsBySource.reduce((s, t) => s + t.tds, 0) as Paise,
    salary, interestSavings, interestDeposit, interestOther, dividends,
    securitiesSold: income("securities-sale"),
    appSaleProceeds: saleProceedsFor(db, memberId, fy),
    unread: rows.filter((r) => r.category === "unread")
      .map((r) => ({ label: r.label, source: r.source, amount: r.amount as Paise })),
    incomeOffer: (salary + interestSavings + interestDeposit + interestOther + dividends) as Paise,
  };
}

/**
 * What the app recorded as proceeds from sales in this member's own holdings
 * in the year — whose sale it is follows the account's holder, as in the
 * gains engine (WEALTH-7). Rupee-priced instruments only: the AIS's sales are
 * reported by Indian depositories and registrars (Handbook §4.30). Proceeds
 * here are net of charges; the AIS figure is the sale consideration, so a
 * small difference is expected.
 */
export function saleProceedsFor(db: DB, memberId: string, fy: number): Paise {
  const { from, to } = fiscalYearRange(fy);
  const soleMember = (queryOne<{ n: number }>(
    db, `SELECT COUNT(*) AS n FROM members WHERE removed_at IS NULL`,
  )?.n ?? 0) <= 1;
  const row = queryOne<{ total: number | null }>(
    db,
    `SELECT SUM(e.amount) AS total
       FROM holding_events e
       JOIN holdings h ON h.id = e.holding_id
       JOIN instruments i ON i.id = h.instrument_id
       LEFT JOIN accounts a ON a.id = h.account_id
      WHERE e.kind = 'sale' AND e.date BETWEEN ? AND ? AND i.currency = 'INR'
        AND (a.holder_member_id = ? OR (a.holder_member_id IS NULL AND ?))`,
    from, to, memberId, soleMember ? 1 : 0,
  );
  return (row?.total ?? 0) as Paise;
}

/**
 * The AIS's figures offered into the form: TDS raised to the AIS's total and
 * gross income raised to the AIS's salary, interest and dividends. Never
 * lowered — somebody whose own figure is higher knows something the AIS does
 * not (income it does not report) — and never saved here.
 */
export function applyAisSuggestion(
  typed: { gross: Paise; tds: Paise }, s: AisSummary,
): { gross: Paise; tds: Paise } {
  return {
    gross: Math.max(typed.gross, s.incomeOffer) as Paise,
    tds: Math.max(typed.tds, s.tdsTotal) as Paise,
  };
}
