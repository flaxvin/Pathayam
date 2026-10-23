/**
 * OFFLINE-1 · The write-only queue for the Add form (`10` §3.7, amending R35).
 *
 * A spend entered at a counter with no signal used to be lost unless the tab
 * stayed open long enough for R36's in-memory retry to find a connection. The
 * owner reversed that trade, using the escape hatch `08` §3.3 wrote down in
 * advance: outbound entries only, purged once the server confirms, and no read
 * cache of any kind.
 *
 * This file holds the queue's *decisions* — what to keep, what to drop, what a
 * response means — as plain functions over plain arrays, with no storage, no
 * DOM and no network. They are spliced into the client script as source text,
 * so the code a test calls is byte for byte the code the browser runs; the
 * client script owns the side effects (localStorage, fetch, the banner).
 *
 * Like the rest of the client script this is a `String.raw` template: no
 * backtick and no dollar-brace anywhere in it, including comments.
 *
 * An entry is:
 *
 *   { id, key, member, path, fields: [[name, value], ...], savedAt,
 *     state: "waiting" | "refused", message }
 *
 * `key` is the Idempotency-Key the first attempt was sent with, and every
 * replay reuses it (R36.1), which is what makes "send it again" safe: if the
 * first attempt did reach the server and only the answer was lost, the replay
 * gets that original answer back rather than a second transaction (R36.2).
 */

export const OUTBOX_LOGIC = String.raw`
  // The one storage key the client script may use (R35 as amended).
  var OUTBOX_STORAGE_KEY = "pathayam.outbox.v1";

  // R36.3 keeps a key for seven days. An entry older than that may be replayed
  // as a new operation, so it is no longer sent automatically: the person is
  // asked to check it is not already there. Six days leaves a day of slack
  // for clocks and time zones.
  var OUTBOX_MAX_AGE_MS = 6 * 24 * 60 * 60 * 1000;

  function outboxValidEntry(e) {
    return Boolean(e) && typeof e === "object" &&
      typeof e.id === "string" && e.id !== "" &&
      typeof e.key === "string" && e.key !== "" &&
      typeof e.member === "string" && e.member !== "" &&
      e.path === "/add" &&
      Array.isArray(e.fields) &&
      e.fields.every(function (pair) {
        return Array.isArray(pair) && pair.length === 2 &&
          typeof pair[0] === "string" && typeof pair[1] === "string";
      }) &&
      typeof e.savedAt === "number" &&
      (e.state === "waiting" || e.state === "refused");
  }

  // Whatever is in storage was written by an older version of this script, by
  // another tab, or by nobody sensible. Anything malformed is dropped rather
  // than allowed to break every page load.
  function outboxParse(raw) {
    if (!raw) return [];
    var parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(outboxValidEntry);
  }

  function outboxSerialise(entries) {
    return JSON.stringify(entries);
  }

  // Build an entry from the form's name/value pairs. Files are never queued:
  // the Add form has none, and a File does not survive JSON.
  function outboxEntry(opts) {
    return {
      id: opts.id || opts.key,
      key: opts.key,
      member: opts.member,
      path: "/add",
      fields: opts.fields
        .filter(function (pair) { return typeof pair[1] === "string"; })
        .map(function (pair) { return [String(pair[0]), pair[1]]; }),
      savedAt: opts.now,
      state: "waiting",
      message: null,
    };
  }

  // Add, or replace the entry with the same id: an entry reopened in the Add
  // form and saved without signal again takes the place of the old one rather
  // than sitting beside it.
  function outboxPut(entries, entry) {
    var replaced = false;
    var next = entries.map(function (e) {
      if (e.id !== entry.id) return e;
      replaced = true;
      return entry;
    });
    if (!replaced) next.push(entry);
    return next;
  }

  function outboxRemove(entries, id) {
    return entries.filter(function (e) { return e.id !== id; });
  }

  // Another member signed in on this device. Their queued entries are not
  // this person's to send — the server would file them as this person's — so
  // they go, and the page says so.
  function outboxClaim(entries, member) {
    var mine = [];
    var dropped = 0;
    entries.forEach(function (e) {
      if (e.member === member) mine.push(e);
      else dropped++;
    });
    return { entries: mine, dropped: dropped };
  }

  // Entries past the key's lifetime stop being sent and are held for a look.
  function outboxAge(entries, now) {
    return entries.map(function (e) {
      if (e.state !== "waiting" || now - e.savedAt <= OUTBOX_MAX_AGE_MS) return e;
      return Object.assign({}, e, {
        state: "refused",
        message:
          "This has waited on this device for almost a week, so it is no longer " +
          "safe to send it automatically. Check it is not already in your " +
          "transactions, then open it to save it, or discard it.",
      });
    });
  }

  function outboxSendable(entries) {
    return entries.filter(function (e) { return e.state === "waiting"; });
  }

  /*
   * What the server's answer means for one entry. Returns
   * { outcome, entries } where outcome is one of:
   *
   *   sent     — confirmed; the entry is gone.
   *   refused  — the server said no for a reason resending will not fix. Kept,
   *              with the server's words, never silently dropped.
   *   signin   — the session has gone. Kept; nothing more is tried until the
   *              person signs in again.
   *   later    — the server is busy, still working on it, or broken. Kept
   *              waiting, and this round stops.
   *
   * A 200 that is not JSON is the "Already reconciled" question: the entry
   * was dated inside a reconciled period and marked cleared, and the queue
   * cannot answer a question on somebody's behalf.
   */
  function outboxAfterResponse(entries, id, response) {
    var status = response.status;
    if (status >= 200 && status < 300) {
      if (response.json) return { outcome: "sent", entries: outboxRemove(entries, id) };
      return outboxRefuse(entries, id,
        "This one needs you to confirm something before it can be saved. Open it to see what.");
    }
    if (status === 401) return { outcome: "signin", entries: entries };
    if (status === 408 || status === 409 || status === 429 || status >= 500) {
      return { outcome: "later", entries: entries };
    }
    return outboxRefuse(entries, id, response.error || "The server could not save this one.");
  }

  function outboxRefuse(entries, id, message) {
    return {
      outcome: "refused",
      entries: entries.map(function (e) {
        return e.id === id ? Object.assign({}, e, { state: "refused", message: message }) : e;
      }),
    };
  }

  function outboxField(entry, name) {
    for (var i = 0; i < entry.fields.length; i++) {
      if (entry.fields[i][0] === name) return entry.fields[i][1];
    }
    return "";
  }

  // One line a person can recognise their entry by: what they typed, not a
  // reformatted version of it, because the amount may still be a sum.
  function outboxDescribe(entry) {
    var amount = outboxField(entry, "amount").trim() || "No amount";
    var direction = outboxField(entry, "direction") === "in" ? "in" : "out";
    var payee = outboxField(entry, "payee").trim();
    var date = outboxField(entry, "date").trim();
    return amount + " " + direction +
      (payee ? ", " + payee : "") +
      (date ? ", " + date : "");
  }

  function outboxSummary(entries) {
    var waiting = entries.filter(function (e) { return e.state === "waiting"; }).length;
    var refused = entries.length - waiting;
    var parts = [];
    if (waiting === 1) parts.push("1 entry is saved on this device, waiting to be sent.");
    else if (waiting > 1) parts.push(waiting + " entries are saved on this device, waiting to be sent.");
    if (refused === 1) parts.push("1 entry needs a look before it can be saved.");
    else if (refused > 1) parts.push(refused + " entries need a look before they can be saved.");
    return { waiting: waiting, refused: refused, text: parts.join(" ") };
  }
`;

/** The functions `OUTBOX_LOGIC` defines, for tests that execute it. */
export const OUTBOX_FUNCTIONS = [
  "outboxParse", "outboxSerialise", "outboxEntry", "outboxPut", "outboxRemove",
  "outboxClaim", "outboxAge", "outboxSendable", "outboxAfterResponse",
  "outboxDescribe", "outboxSummary",
] as const;
