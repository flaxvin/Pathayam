/**
 * Waitlist → Google Sheet.
 *
 * A bound Apps Script is the whole backend: the site posts here, this appends a
 * row. No server, no database, no third-party form service holding the list.
 *
 * ── Setting it up ───────────────────────────────────────────────────────────
 *
 *  1. Make a Google Sheet. Name the first tab `Waitlist`.
 *  2. Extensions → Apps Script. Delete the placeholder, paste this file, save.
 *  3. Run `setUpSheet` once from the editor and grant the permission it asks
 *     for. This writes the header row; without it the first submission still
 *     works but the columns are unlabelled.
 *  4. Deploy → New deployment → type **Web app**.
 *       Execute as:        Me
 *       Who has access:    Anyone
 *     Copy the /exec URL it gives you.
 *  5. Put that URL in `WAITLIST_ENDPOINT` at the top of site.js and republish.
 *
 * Re-deploy as a *new version* after any edit here — Apps Script serves the
 * deployed version, not the saved one, and editing without redeploying is the
 * usual reason a change appears to do nothing.
 *
 * ── What it stores ──────────────────────────────────────────────────────────
 *
 * An email address, which tier the person was looking at, the page they were
 * on, and a timestamp. Nothing else, and nothing that identifies a device.
 * Duplicate addresses are updated in place rather than appended, so the sheet
 * stays a list of people rather than a log of clicks.
 */

var SHEET_NAME = "Waitlist";
var HEADERS = ["Joined (IST)", "Email", "Tier", "Page", "Source"];

function setUpSheet() {
  var sheet = sheetOrCreate_();
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight("bold");
    sheet.setFrozenRows(1);
  }
  return "ready";
}

function doPost(e) {
  try {
    var data = parseBody_(e);
    var email = String(data.email || "").trim().toLowerCase();

    // Same check the page makes, repeated here because the page is not the
    // only thing that can post to this URL.
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return json_({ ok: false, error: "invalid email" });
    }
    // The form carries a field no human sees. Anything that fills it is not a
    // human, and is dropped without saying so.
    if (String(data.company || "") !== "") {
      return json_({ ok: true });
    }

    var sheet = sheetOrCreate_();
    if (sheet.getLastRow() === 0) setUpSheet();

    var when = Utilities.formatDate(new Date(), "Asia/Kolkata", "yyyy-MM-dd HH:mm:ss");
    var row = [when, email, String(data.tier || ""), String(data.page || ""), "website"];

    var existing = findRowByEmail_(sheet, email);
    if (existing > 0) {
      sheet.getRange(existing, 1, 1, row.length).setValues([row]);
    } else {
      sheet.appendRow(row);
    }
    return json_({ ok: true });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

/** So opening the URL in a browser says something rather than erroring. */
function doGet() {
  return json_({ ok: true, note: "Waitlist endpoint. POST an email address." });
}

function parseBody_(e) {
  if (!e || !e.postData) return {};
  var raw = e.postData.contents || "";
  try {
    return JSON.parse(raw);
  } catch (ignored) {
    // Form-encoded fallback, so a plain <form> post works too.
    return (e.parameter || {});
  }
}

function findRowByEmail_(sheet, email) {
  var last = sheet.getLastRow();
  if (last < 2) return 0;
  var column = sheet.getRange(2, 2, last - 1, 1).getValues();
  for (var i = 0; i < column.length; i++) {
    if (String(column[i][0]).trim().toLowerCase() === email) return i + 2;
  }
  return 0;
}

function sheetOrCreate_() {
  var book = SpreadsheetApp.getActiveSpreadsheet();
  return book.getSheetByName(SHEET_NAME) || book.insertSheet(SHEET_NAME);
}

function json_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
