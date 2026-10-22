/**
 * IMPORT-1 · Reading the export of the budgeting app a household is leaving.
 *
 * Two shapes are recognised from their header row, on the ordinary CSV import
 * screen, before any bank mapping is tried:
 *
 * - **YNAB's register export.** `Account, Flag, Date, Payee, Category
 *   Group/Category, Category Group, Category, Memo, Outflow, Inflow, Cleared`.
 *   Amounts carry the budget's currency symbol (`₹1,200.00`, `$12.50`,
 *   `12,50 €`) and dates are in the budget's own date format, which the file
 *   never names. The older YNAB 4 export (`Master Category`, `Sub Category`)
 *   is read by the same column names.
 * - **Actual Budget's transaction export** [unverified: the column names below
 *   are from memory of Actual's export code, not from a file it produced, so
 *   every column is found by name and most are optional]. `Account, Date,
 *   Payee, Notes, Category, Amount`, and on a split, `Split_Amount` on the
 *   lines under the parent row.
 *
 * Unlike a bank statement, one file covers every account the household had,
 * so each row keeps the name of its source account; which Pathayam account
 * that is, the person says on the next screen (`budget-app-import.ts`).
 *
 * Pure: text in, rows out. Nothing here reads the database.
 */

import type { Paise } from "../core/money.ts";
import { calendarDate, fullYear, type IsoDate } from "../core/dates.ts";
import { parseDelimited, detectDelimiter, type ParseError } from "./csv.ts";

export type BudgetApp = "ynab" | "actual";

export const BUDGET_APP_NAMES: Record<BudgetApp, string> = {
  ynab: "YNAB",
  actual: "Actual Budget",
};

/** How the file writes a numeric date. */
export type DateOrder = "dd-mm-yyyy" | "mm-dd-yyyy" | "yyyy-mm-dd";

/** A category as the other app named it. */
export interface SourceCategory {
  group: string | null;
  name: string;
}

/** One line of a split, as the other app had it. */
export interface SourceSplitLine {
  amount: Paise;
  category: SourceCategory | null;
  memo: string | null;
}

/** One transaction from the other app, before any Pathayam account is chosen. */
export interface SourceTransaction {
  /** The file's row number (1-based) of its first line. */
  rowNumber: number;
  account: string;
  date: IsoDate;
  amount: Paise;
  payee: string | null;
  memo: string | null;
  category: SourceCategory | null;
  /** The other source account, when this row is money moved between two of them. */
  transferTo: string | null;
  /** Two or more lines, summing to `amount`, when the other app split it. */
  splits: SourceSplitLine[] | null;
  /** P4 · What the file wrote, kept unchanged. */
  raw: { date: string; amount: string; narration: string };
}

export interface BudgetAppParse {
  app: BudgetApp;
  /** Every source account named in the file, in the order first seen. */
  accounts: string[];
  /** How many rows each source account has in the file. */
  accountRows: Record<string, number>;
  transactions: SourceTransaction[];
  errors: (ParseError & { account: string | null })[];
  /** Rows that carried a transaction, read or not. */
  rowsRead: number;
  /** "Starting Balance" rows, left out: the Pathayam account has its own. */
  startingBalances: number;
  /** The date order used, or null when the dates could not be read yet. */
  dateOrder: DateOrder | null;
  /**
   * Set when every numeric date in the file reads both ways (all days 12 or
   * under) and the person has not said which way round they are. No row is
   * read until they do: guessing would put some months' rows in the wrong one.
   */
  needsDateOrder: boolean;
  /** Set when the dates prove both orders (13/09 and 09/14): nothing is read. */
  dateProblem: string | null;
}

// ---------------------------------------------------------------------------
// Recognising the header
// ---------------------------------------------------------------------------

/** `Category Group/Category` → `category group category`. */
function normalise(header: string): string {
  return header.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

interface Columns {
  account: number;
  date: number;
  payee: number;
  memo: number;
  /** YNAB's "Category Group/Category", or YNAB 4's "Category": "Group: Name". */
  combined: number;
  group: number;
  category: number;
  outflow: number;
  inflow: number;
  amount: number;
  splitAmount: number;
  isParent: number;
  isChild: number;
}

function columnsOf(headers: string[]): Columns {
  const names = headers.map(normalise);
  const find = (...aliases: string[]) => {
    for (const alias of aliases) {
      const i = names.indexOf(alias);
      if (i >= 0) return i;
    }
    return -1;
  };
  const group = find("category group", "master category", "group", "category group name");
  const sub = find("sub category", "subcategory");
  const combinedYnab = find("category group category");
  const plain = find("category", "category name");
  return {
    account: find("account", "account name"),
    date: find("date", "transaction date"),
    payee: find("payee", "payee name", "imported payee"),
    memo: find("memo", "notes", "note"),
    // YNAB 4 has Category beside Master and Sub: there it is the combined one.
    combined: combinedYnab >= 0 ? combinedYnab : sub >= 0 ? plain : -1,
    group,
    category: sub >= 0 ? sub : plain,
    outflow: find("outflow", "payment"),
    inflow: find("inflow", "deposit"),
    amount: find("amount"),
    splitAmount: find("split amount", "splitamount"),
    isParent: find("isparent", "is parent"),
    isChild: find("ischild", "is child"),
  };
}

/**
 * Which app wrote this file, from its header row, or null for anything else.
 * A bank statement never names an Account column beside a Payee one, so the
 * ordinary CSV path is untouched.
 */
export function detectBudgetApp(rows: string[][]): { app: BudgetApp; headerRow: number } | null {
  for (let r = 0; r < Math.min(rows.length, 5); r++) {
    const c = columnsOf(rows[r] ?? []);
    if (c.account < 0 || c.date < 0 || c.payee < 0) continue;
    if (c.outflow >= 0 && c.inflow >= 0) return { app: "ynab", headerRow: r };
    if (c.amount >= 0 && (c.memo >= 0 || c.category >= 0)) return { app: "actual", headerRow: r };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Amounts
// ---------------------------------------------------------------------------

/**
 * Which character a column uses for its decimal point. YNAB writes amounts in
 * the budget's own number format, so `1.234,56` is as likely as `1,234.56`.
 * The column decides, not each cell: a cell ending in a separator and one or
 * two digits shows the decimal; `1,234` alone shows nothing.
 */
export function decimalSeparatorOf(cells: string[]): "." | "," {
  let dot = 0;
  let comma = 0;
  for (const cell of cells) {
    const m = /([.,])\d{1,2}\D*$/.exec(cell.trim());
    if (!m) continue;
    if (m[1] === ".") dot++;
    else comma++;
  }
  return comma > 0 && dot === 0 ? "," : ".";
}

/**
 * An amount as a budgeting app prints it, in paise, or null when it is not one.
 *
 * The currency symbol or code is dropped, whatever it is (`₹`, `$`, `€`,
 * `Rs.`, `INR`); grouping by commas, dots, spaces or apostrophes is dropped
 * once the decimal separator is known. A minus anywhere before the digits, or
 * brackets, is money out. More than two decimal places is refused, not
 * rounded, as everywhere else. An empty cell is zero: YNAB leaves the side a
 * row does not use at `0.00`, Actual sometimes empty.
 */
export function parseAppAmount(raw: string, decimal: "." | "," = "."): Paise | null {
  let s = raw.trim();
  if (s === "") return 0 as Paise;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (/[-−]/.test(s.replace(/\d.*$/, ""))) negative = true;
  // The symbol or code either side, and the minus; inside, only grouping.
  s = s.replace(/^\D+/, "").replace(/\D+$/, "");
  if (/[^\d.,'\s  ]/.test(s)) return null;
  const grouping = decimal === "." ? /[,'\s  ]/g : /[.'\s  ]/g;
  s = s.replace(grouping, "");
  if (decimal === ",") s = s.replace(",", ".");
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const paise = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  if (!Number.isSafeInteger(paise)) return null;
  return (negative && paise !== 0 ? -paise : paise) as Paise;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const YEAR_FIRST = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/;
const PARTS_FIRST = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})(?:\s.*)?$/;

/**
 * Which way round the file's dates are, judged from every row.
 *
 * A first part over 12 proves day first, a second part over 12 month first;
 * a year in front is unambiguous. Proof both ways is `mixed` and refused.
 * No proof at all — every day of every row 12 or under — is null: the file
 * alone cannot say, and the person is asked rather than given a guess.
 */
export function appDateOrder(cells: string[]): DateOrder | "mixed" | null {
  let dayFirst = false;
  let monthFirst = false;
  let yearFirst = false;
  for (const cell of cells) {
    const raw = cell.trim();
    if (YEAR_FIRST.test(raw)) {
      yearFirst = true;
      continue;
    }
    const m = PARTS_FIRST.exec(raw);
    if (!m) continue;
    if (Number(m[1]) > 12) dayFirst = true;
    if (Number(m[2]) > 12) monthFirst = true;
  }
  if (dayFirst && monthFirst) return "mixed";
  if (dayFirst) return "dd-mm-yyyy";
  if (monthFirst) return "mm-dd-yyyy";
  // Only year-first dates (or none that are numeric): nothing to ask.
  if (yearFirst || !cells.some((c) => PARTS_FIRST.test(c.trim()))) return "yyyy-mm-dd";
  return null;
}

function readAppDate(raw: string, order: DateOrder): IsoDate | null {
  const s = raw.trim();
  const ymd = YEAR_FIRST.exec(s);
  if (ymd) return calendarDate(Number(ymd[1]), Number(ymd[2]), Number(ymd[3]));
  const m = PARTS_FIRST.exec(s);
  if (!m || order === "yyyy-mm-dd") return null;
  const [a, b] = [Number(m[1]), Number(m[2])];
  const year = fullYear(m[3]!);
  return order === "dd-mm-yyyy" ? calendarDate(year, b, a) : calendarDate(year, a, b);
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** YNAB: `Split (1/3) memo`; YNAB 4: `(Split 1/3) memo`. */
const SPLIT_MEMO = /^\(?\s*split\s*\(?\s*(\d+)\s*\/\s*(\d+)\s*\)?\s*\)?\s*/i;
/** YNAB names the other account in the payee: `Transfer : HDFC Savings`. */
const TRANSFER_PAYEE = /^transfer\s*(?::|to|from)\s*(.+)$/i;
/** The categories that mean "new money", not an envelope. */
const INCOME_CATEGORY = /^(?:inflow\s*:\s*)?(?:ready to assign|to be budgeted|income for this month|income for next month|available for budgeting)$/i;

interface Line {
  rowNumber: number;
  cells: string[];
  account: string;
  rawDate: string;
  date: IsoDate | null;
  amount: Paise | null;
  rawAmount: string;
  payee: string | null;
  memo: string | null;
  category: SourceCategory | null;
  split: { index: number; of: number } | null;
  /** Actual: a split line under its parent row. */
  child: boolean;
  parent: boolean;
}

/**
 * Read a budgeting app's export.
 *
 * `dateOrder` is the person's answer, when the file needed asking; without
 * it, a file whose dates read both ways is returned with `needsDateOrder` and
 * no rows. Returns null for a file neither app wrote.
 */
export function parseBudgetApp(
  text: string, opts: { dateOrder?: DateOrder | null } = {},
): BudgetAppParse | null {
  const rows = parseDelimited(text, detectDelimiter(text));
  const found = detectBudgetApp(rows);
  if (!found) return null;
  const { app, headerRow } = found;
  const c = columnsOf(rows[headerRow]!);
  const cell = (cells: string[], i: number) => (i >= 0 ? (cells[i] ?? "").trim() : "");

  const data = rows
    .map((cells, i) => ({ cells, rowNumber: i + 1 }))
    .slice(headerRow + 1)
    .filter(({ cells }) => cells.some((x) => x.trim() !== ""));

  const accounts: string[] = [];
  const accountRows: Record<string, number> = {};
  for (const { cells } of data) {
    const name = cell(cells, c.account);
    if (!name) continue;
    if (!accounts.includes(name)) accounts.push(name);
    accountRows[name] = (accountRows[name] ?? 0) + 1;
  }

  const result: BudgetAppParse = {
    app, accounts, accountRows, transactions: [], errors: [], rowsRead: data.length, startingBalances: 0,
    dateOrder: null, needsDateOrder: false, dateProblem: null,
  };

  const detected = appDateOrder(data.map(({ cells }) => cell(cells, c.date)));
  if (detected === "mixed") {
    result.dateProblem =
      "Some dates in this file put the day first (13/09) and others the month (09/13), " +
      "so it is not clear which is which, and nothing has been read. " +
      "Check the date format in the other app's settings and export the file again.";
    return result;
  }
  const order = detected ?? opts.dateOrder ?? null;
  if (!order) {
    result.needsDateOrder = true;
    return result;
  }
  result.dateOrder = order;

  const amountCells = (i: number) => data.map(({ cells }) => cell(cells, i));
  const decimal = decimalSeparatorOf([
    ...amountCells(c.outflow), ...amountCells(c.inflow),
    ...amountCells(c.amount), ...amountCells(c.splitAmount),
  ]);

  const lines: Line[] = data.map(({ cells, rowNumber }) => {
    const rawDate = cell(cells, c.date);
    let amount: Paise | null;
    let rawAmount: string;
    let child = false;
    if (app === "ynab" || (c.amount < 0 && c.outflow >= 0)) {
      const out = parseAppAmount(cell(cells, c.outflow), decimal);
      const into = parseAppAmount(cell(cells, c.inflow), decimal);
      amount = out === null || into === null ? null : (into - Math.abs(out)) as Paise;
      rawAmount = out !== null && out !== 0
        ? `Outflow ${cell(cells, c.outflow)}`
        : `Inflow ${cell(cells, c.inflow)}`;
    } else {
      const split = cell(cells, c.splitAmount);
      const splitAmount = split ? parseAppAmount(split, decimal) : 0;
      const flaggedChild = c.isChild >= 0 && /^(?:true|1|yes)$/i.test(cell(cells, c.isChild));
      child = flaggedChild || (splitAmount !== null && splitAmount !== 0);
      rawAmount = child ? split : cell(cells, c.amount);
      amount = parseAppAmount(rawAmount, decimal);
    }

    const memoCell = cell(cells, c.memo);
    const splitMatch = app === "ynab" ? SPLIT_MEMO.exec(memoCell) : null;
    const memo = (splitMatch ? memoCell.slice(splitMatch[0].length) : memoCell).trim() || null;

    return {
      rowNumber, cells, account: cell(cells, c.account), rawDate,
      date: readAppDate(rawDate, order), amount, rawAmount,
      payee: cell(cells, c.payee) || null, memo,
      category: categoryOf(cell(cells, c.combined), cell(cells, c.group), cell(cells, c.category)),
      split: splitMatch ? { index: Number(splitMatch[1]), of: Number(splitMatch[2]) } : null,
      child,
      parent: c.isParent >= 0 && /^(?:true|1|yes)$/i.test(cell(cells, c.isParent)),
    };
  });

  const fail = (line: Line, reason: string) =>
    result.errors.push({ rowNumber: line.rowNumber, cells: line.cells, reason, account: line.account || null });

  // Lines that are fine on their own: a date, an amount, an account.
  const usable = (line: Line): boolean => {
    if (!line.account) {
      fail(line, "This row names no account, so there is nowhere to put it.");
      return false;
    }
    if (!line.date) {
      fail(line, `"${line.rawDate}" is not a date I can read.`);
      return false;
    }
    if (line.amount === null) {
      fail(line, `"${line.rawAmount}" is not an amount I can read.`);
      return false;
    }
    return true;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // YNAB · "Split (1/3)", "(2/3)", "(3/3)" on consecutive rows: one transaction.
    if (line.split) {
      const group: Line[] = [line];
      while (group.length < line.split.of && i + 1 < lines.length) {
        const next = lines[i + 1]!;
        if (!next.split || next.split.index !== group.length + 1 || next.split.of !== line.split.of
          || next.account !== line.account || next.rawDate !== line.rawDate) break;
        group.push(next);
        i++;
      }
      if (line.split.index !== 1 || group.length !== line.split.of) {
        for (const g of group) {
          fail(g, `This is part of a split whose other parts are not beside it (expected ${line.split.of} parts), so the split cannot be put back together.`);
        }
        continue;
      }
      if (!group.every(usable)) continue;
      result.transactions.push(...fromSplit(group, accounts));
      continue;
    }

    // Actual · a parent row with its split lines under it.
    if (app === "actual" && !line.child && i + 1 < lines.length && lines[i + 1]!.child) {
      const group: Line[] = [];
      while (i + 1 < lines.length && lines[i + 1]!.child
        && lines[i + 1]!.account === line.account && lines[i + 1]!.rawDate === line.rawDate) {
        group.push(lines[i + 1]!);
        i++;
      }
      if (!usable(line) || !group.every(usable)) continue;
      const sum = group.reduce((s, g) => s + g.amount!, 0);
      if (sum !== line.amount) {
        fail(line, `The split's lines add up to ${sum / 100}, but the row says ${line.amount! / 100}; I cannot tell which is right.`);
        continue;
      }
      result.transactions.push(...fromSplit(
        group.map((g) => ({ ...g, payee: g.payee ?? line.payee })), accounts,
        { rowNumber: line.rowNumber, rawAmount: line.rawAmount, payee: line.payee, memo: line.memo },
      ));
      continue;
    }
    if (app === "actual" && line.child) {
      fail(line, "This is a line of a split with no parent row above it, so the split cannot be put back together.");
      continue;
    }
    if (line.parent) {
      fail(line, "This split's lines are missing, so what it was split into is not known.");
      continue;
    }

    if (!usable(line)) continue;
    if (line.amount === 0) {
      result.rowsRead--;
      continue; // A zero row moves nothing: YNAB writes them for a cleared-off flag.
    }
    if (/^starting balance$/i.test(line.payee ?? "")) {
      result.startingBalances++;
      result.rowsRead--;
      continue;
    }
    result.transactions.push(single(line, accounts));
  }

  return result;
}

function categoryOf(combined: string, group: string, name: string): SourceCategory | null {
  if (name) {
    if (INCOME_CATEGORY.test(name) || INCOME_CATEGORY.test(`${group}: ${name}`)) return null;
    return { group: group || null, name };
  }
  if (combined) {
    if (INCOME_CATEGORY.test(combined)) return null;
    const at = combined.indexOf(":");
    return at > 0
      ? { group: combined.slice(0, at).trim(), name: combined.slice(at + 1).trim() }
      : { group: null, name: combined };
  }
  return null;
}

/** The other source account this payee names, or null when it names none. */
function transferTarget(payee: string | null, account: string, accounts: string[]): string | null {
  if (!payee) return null;
  const named = TRANSFER_PAYEE.exec(payee)?.[1]?.trim() ?? payee.trim();
  const other = accounts.find((a) => a.toLowerCase() === named.toLowerCase());
  return other && other !== account ? other : null;
}

function single(line: Line, accounts: string[]): SourceTransaction {
  const transferTo = line.category ? null : transferTarget(line.payee, line.account, accounts);
  return {
    rowNumber: line.rowNumber, account: line.account, date: line.date!, amount: line.amount!,
    payee: line.payee, memo: line.memo,
    category: transferTo ? null : line.category,
    transferTo, splits: null,
    raw: { date: line.rawDate, amount: line.rawAmount, narration: line.payee ?? line.memo ?? "" },
  };
}

/**
 * A split put back together. A line that is itself a transfer to another of
 * the household's accounts comes out as a transfer of its own — Pathayam
 * cannot hold a transfer inside a split — and the rest stay one split, or one
 * ordinary row when only one line is left. The account's balance is the same
 * either way.
 */
function fromSplit(
  group: Line[], accounts: string[],
  head?: { rowNumber: number; rawAmount: string; payee: string | null; memo: string | null },
): SourceTransaction[] {
  const first = group[0]!;
  const out: SourceTransaction[] = [];
  const kept: Line[] = [];
  for (const line of group) {
    const transferTo = line.category ? null : transferTarget(line.payee, line.account, accounts);
    if (transferTo) out.push({ ...single(line, accounts), transferTo });
    else kept.push(line);
  }
  if (kept.length === 1) {
    out.unshift({ ...single(kept[0]!, accounts), transferTo: null, payee: head?.payee ?? kept[0]!.payee });
  } else if (kept.length > 1) {
    const amount = kept.reduce((s, l) => s + l.amount!, 0) as Paise;
    const payee = head?.payee ?? first.payee;
    out.unshift({
      rowNumber: head?.rowNumber ?? first.rowNumber,
      account: first.account, date: first.date!, amount,
      payee, memo: head?.memo ?? null, category: null, transferTo: null,
      splits: kept.map((l) => ({ amount: l.amount!, category: l.category, memo: l.memo })),
      raw: {
        date: first.rawDate,
        amount: head && kept.length === group.length ? head.rawAmount : kept.map((l) => l.rawAmount).join(" + "),
        narration: payee ?? "",
      },
    });
  }
  return out;
}
