/**
 * FWD-2 · A forwarded message, from the receiver's hand-off to Review.
 *
 * The receiver (src/mx) has already checked the domain and the household's
 * route, and signed the hand-off (src/mail/signature.ts). Here the app checks
 * what only it can:
 *
 *   1. **The token** names one of its members. Otherwise 404, and the
 *      receiver refuses the message, so a sender learns the address is dead.
 *   2. **The sender is a bank the import reads** — the same list the Gmail
 *      fetch searches (`buildQuery`). Anything else is logged by sender and
 *      subject and dropped unread: an address that leaks is not a way to put
 *      arbitrary text in front of the import.
 *   3. **The bank's own DKIM signature checks out** and is the From domain's.
 *      An automatic forward (a Gmail filter, an Outlook rule) leaves the
 *      original message intact, signature and all; a "From:" anybody can type
 *      does not come with one. A message without a good signature is logged
 *      and dropped. A manual "Forward" rewrites the message and breaks the
 *      signature, which is why the guide asks for a filter.
 *
 * Then the message goes through exactly what a Gmail fetch does with it
 * (`startMailIngest`), so it lands in Review the same way. Nothing of the
 * message is kept but a log line — sender, subject, outcome — and, for a
 * statement no password opened, the PDF itself, sealed, until it opens or 90
 * days pass (`held.ts`).
 *
 * One exception to rule 2: Gmail's own "confirm forwarding" message, which a
 * member has to answer before Gmail forwards anything. Its code is logged so
 * Settings can show it.
 */

import { createHash } from "node:crypto";
import type { DB } from "../db/db.ts";
import { execute, newId } from "../db/db.ts";
import type { Actor } from "../core/events.ts";
import { nowIST, todayIST } from "../core/dates.ts";
import { parseMail, type ParsedMail } from "../mail/mime.ts";
import { verifyDkim, alignedPass, alignedTempError, type TxtResolver } from "../mail/dkim.ts";
import { emptyFetchResult, knownBankSender, startMailIngest, type FetchResult } from "../gmail/fetch.ts";
import { memberForToken, markReceived } from "./address.ts";
import { holdStatement } from "./held.ts";

export type ForwardOutcome = "read" | "nothing" | "not-a-bank" | "unsigned" | "confirmation" | "held";

export interface InboundDeps {
  /** Seals a locked statement while it waits; without it, one is not kept. */
  secretsKey: Buffer | null;
  /** DNS TXT lookups for DKIM keys; injectable so tests need no network. */
  resolveTxt?: TxtResolver;
  now?: Date;
}

export type InboundResult =
  | { status: "unknown-address" }
  | { status: "try-later" }
  | { status: "taken"; memberId: string; outcome: ForwardOutcome; result: FetchResult | null };

/** Gmail's sender for "confirm forwarding to this address". */
const GMAIL_CONFIRMATION_SENDER = "forwarding-noreply@google.com";

export async function receiveForwarded(
  db: DB, deps: InboundDeps, token: string, raw: Uint8Array,
): Promise<InboundResult> {
  const memberId = memberForToken(db, token);
  if (!memberId) return { status: "unknown-address" };

  const mail = parseMail(raw);
  const dkim = await verifyDkim(raw, deps.resolveTxt, deps.now);
  const signed = !repeatsReadHeader(mail) && alignedPass(dkim, mail.from);
  // MAIL-4 · The bank's key could not be fetched just now (a DNS timeout).
  // Judged now, a genuine alert would be logged as forged and lost; answered
  // as a temporary failure, the sending server keeps it and tries again.
  if (!signed && knownBankSender(mail.from) && alignedTempError(dkim, mail.from)) {
    return { status: "try-later" };
  }
  markReceived(db, memberId);

  const log = (outcome: ForwardOutcome, detail: string | null, confirmation: string | null = null) =>
    logForwarded(db, memberId, mail, signed, outcome, detail, confirmation, deps.now);

  if (mail.from === GMAIL_CONFIRMATION_SENDER) {
    const confirmation = signed ? gmailConfirmation(mail) : null;
    if (confirmation) {
      log("confirmation", confirmation.link, confirmation.code);
      return { status: "taken", memberId, outcome: "confirmation", result: null };
    }
  }

  if (!knownBankSender(mail.from)) {
    log("not-a-bank", "Not a bank sender Pathayam reads, so it was not opened.");
    return { status: "taken", memberId, outcome: "not-a-bank", result: null };
  }
  if (!signed) {
    log(
      "unsigned",
      "The bank's signature on it did not check out, so nothing was imported. " +
      "Forward with a filter rather than by hand: a manual forward rewrites the message.",
    );
    return { status: "taken", memberId, outcome: "unsigned", result: null };
  }

  const actor: Actor = { memberId, source: "import", sourceDetail: "forwarding" };
  const result = emptyFetchResult();
  result.scanned = 1;
  let held = 0;
  let notKept = 0;
  const run = startMailIngest(db, actor, result, {
    onLocked: (pdf) => {
      if (holdStatement(db, deps.secretsKey, memberId, pdf, deps.now)) held++;
      else notKept++;
    },
  });
  await run.message({
    sender: mail.from,
    subject: mail.subject,
    received: todayIST(mail.date ?? deps.now ?? new Date()),
    body: () => mail.text,
    // IMPORT-3 · Each forwarded message is ingested on its own.
    messageKey: mail.messageId ?? createHash("sha256").update(raw).digest("hex"),
    pdfs: mail.attachments
      .filter((a) => a.contentType.toLowerCase() === "application/pdf" || /\.pdf$/i.test(a.filename))
      .map((a) => ({ filename: a.filename, load: async () => a.bytes })),
  });
  run.finish();

  const notes = [...result.notes];
  // A SafeGold plan waits half an hour for somebody to confirm it, and
  // nobody is at the keyboard when mail arrives: the upload is the way in.
  if (result.gold.statements > 0) {
    notes.push("A SafeGold statement is confirmed row by row: upload it on Portfolio to review it");
  }
  if (notKept > 0) {
    notes.push("A locked statement could not be kept to try again later (SECRETS_KEY is not set on this server)");
  }

  const imported = result.alerts.staged + result.statements.staged;
  const outcome: ForwardOutcome = held > 0 ? "held" : imported > 0 ? "read" : "nothing";
  const detail = [
    imported > 0 ? `${imported} ${imported === 1 ? "row" : "rows"} imported` +
      (result.autoApproved ? ` (${result.autoApproved} approved by a rule)` : "") : null,
    held > 0 ? `${held === 1 ? "A statement" : `${held} statements`} could not be opened and ` +
      `${held === 1 ? "is" : "are"} kept until the missing detail is entered` +
      (result.missingDetails.length ? `: ${result.missingDetails.join(" ")}` : "") : null,
    ...notes,
  ].filter((s): s is string => s !== null).join(". ") || null;
  log(outcome, detail);
  return { status: "taken", memberId, outcome, result };
}

/**
 * The header fields the import reads, each of which a message has at most once
 * (RFC 5322 §3.6, RFC 2045).
 */
const READ_ONCE = ["from", "subject", "date", "content-type", "content-transfer-encoding"];

/**
 * MAIL-2 · Whether a field the import reads appears twice. DKIM checks the
 * bottom-most instance of a signed field (RFC 6376 §5.4.2) and the reader
 * takes the first, so a Subject added above the bank's would be read while
 * the bank's signature still checked out. Mail as a bank sends it, and as a
 * filter forwards it, never repeats one.
 */
function repeatsReadHeader(mail: ParsedMail): boolean {
  const seen = new Set<string>();
  for (const h of mail.headers) {
    const name = h.name.toLowerCase();
    if (!READ_ONCE.includes(name)) continue;
    if (seen.has(name)) return true;
    seen.add(name);
  }
  return false;
}

/**
 * The code (and the link) in Gmail's confirmation message. The subject reads
 * "(#123456789) Gmail Forwarding Confirmation - Receive Mail from …" and the
 * body repeats the code and carries a mail-settings.google.com link.
 */
export function gmailConfirmation(mail: ParsedMail): { code: string; link: string | null } | null {
  const code = /\(#(\d{6,12})\)/.exec(mail.subject)?.[1]
    ?? /confirmation code:\s*(\d{6,12})/i.exec(mail.text)?.[1];
  if (!code) return null;
  const link = /https:\/\/mail-settings\.google\.com\/mail\/[^\s<>"')]+/.exec(mail.text)?.[0] ?? null;
  return { code, link };
}

function logForwarded(
  db: DB, memberId: string, mail: ParsedMail, signed: boolean,
  outcome: ForwardOutcome, detail: string | null, confirmation: string | null, now?: Date,
): void {
  execute(
    db,
    `INSERT INTO forwarded_mail
       (id, member_id, received_at, sender, subject, signed, outcome, detail, confirmation)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    newId(), memberId, nowIST(now), mail.from || "(no sender)",
    // A subject is the one free-text field kept; bounded so a hostile one
    // cannot fill the log.
    mail.subject.slice(0, 200), signed ? 1 : 0, outcome, detail, confirmation,
  );
}
