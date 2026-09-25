/**
 * `04` §3.4 · Parsing bank transaction-alert emails into raw records.
 *
 * These arrive within seconds of a spend and are structured enough to read.
 * Every profile here was written against a real alert from this household's
 * inbox, so the formats are exact rather than assumed:
 *
 *   · **Axis account** — label/value pairs, one per line:
 *       Amount Debited: / INR 600.00 / Account Number: / XX8457 /
 *       Date & Time: / 28-08-26, 00:01:28 IST / Transaction Info: / UPI/P2A/…
 *   · **Axis credit card** — the same shape with Merchant Name and the card
 *       number, and crucially a "Dear <name>," that names the *cardholder* —
 *       which for an add-on card is not the inbox owner (§3.4, R6.e).
 *   · **YES Bank card** — one sentence:
 *       "INR 70.00 has been spent on your YES BANK Credit Card ending with
 *        8803 at UPI_DESI BITES FAST FO on 27-08-2026 at 06:46:36 pm."
 *   · **Axis account, sentence form** — NEFT and IMPS carry none of the
 *       labels above: "your A/c no. XX8457 has been debited with INR 23000.00
 *        on 16-09-2026 06:17:07 IST by NEFT/MB/…"
 *   · **SBI Card** — rupees rather than INR, a two-digit year, and a merchant
 *       with the spaces taken out: "Rs.591.00 spent on your SBI Credit Card
 *        ending 6779 at MSPRETAILPRIVATELIMITE on 05/09/26."
 *   · **IndusInd account** — one sentence, and the only one that states no
 *       date at all, so the message's own date stands in:
 *       "Account No. 15XXXXXX6620 has been Debited for INR 1.00 towards
 *        UPI/400111222333/DR/Moj/…"
 *
 * Output is the same `RawRecord` shape every other source produces, tagged
 * `email`, so it lands in the same review queue (`04` §1). Nothing here posts
 * anything: it reads a message and returns a record or null.
 */

import { calendarDate, fullYear, monthFromName, type IsoDate } from "../core/dates.ts";
import { parseAmount, type Paise } from "../core/money.ts";

export interface AlertRecord {
  /** Signed paise: negative for a debit/spend, positive for a credit. */
  amount: Paise;
  date: IsoDate;
  /** The full timestamp text, kept verbatim for the raw narration. */
  when: string;
  /** Last four of the account or card the alert names, for F2.9 matching. */
  accountLast4: string | null;
  cardLast4: string | null;
  /** Merchant or the raw UPI/NEFT narration. */
  narration: string;
  reference: string | null;
  /** The cardholder the alert greets, when it does — R6.e owner defaulting. */
  cardholderName: string | null;
  /** Available balance, when the alert states one (a reconciliation hint). */
  balance: Paise | null;
}

export interface AlertProfile {
  bank: string;
  /** Sender addresses this profile reads. */
  senders: RegExp[];
  parse: (subject: string, body: string) => AlertRecord | null;
}

// ---------------------------------------------------------------------------
// Shared field readers
// ---------------------------------------------------------------------------

/**
 * `28-08-26`, `28-08-2026`, `27-08-2026`, `27 Aug 2026`.
 *
 * Checked against the calendar (`calendarDate`), as every date reader is: this
 * one accepted any day up to 31, so an alert dated 31/02/2026 staged a row on
 * "2026-02-31".
 */
function parseAlertDate(raw: string): IsoDate | null {
  const numeric = /(\d{1,2})[-/](\d{1,2})[-/](\d{4}|\d{2})\b/.exec(raw);
  if (numeric) {
    return calendarDate(fullYear(numeric[3]!), Number(numeric[2]), Number(numeric[1]));
  }
  const named = /(\d{1,2})[-\s]([A-Za-z]{3})[a-z]*[-\s](\d{4})/.exec(raw);
  if (named) {
    const month = monthFromName(named[2]!);
    if (month !== null) return calendarDate(Number(named[3]), month, Number(named[1]));
  }
  return null;
}

/** `INR 1,234.56`, `INR 198`, `Rs. 600.00` → paise. */
function parseAlertAmount(raw: string): number | null {
  const m = /(?:INR|Rs\.?|₹)\s*([\d,]+(?:\.\d{1,2})?)/i.exec(raw);
  if (!m) return null;
  // The same reader CSV uses, so "INR 1,23" is refused here as it is there
  // rather than stripped of its comma and read as ₹123.
  return parseAmount(m[1]!, "statement");
}

const DEBIT_WORDS = /\b(debited|spent|withdrawn|paid|purchase|deducted)\b/i;
const CREDIT_WORDS = /\b(credited|received|deposited|refund(?:ed)?)\b/i;

function directionSign(text: string): -1 | 1 {
  // Debit is the safe default: the overwhelming majority of alerts are spends,
  // and a mis-signed credit is caught in Review far more easily than the
  // reverse would be.
  if (CREDIT_WORDS.test(text) && !DEBIT_WORDS.test(text)) return 1;
  return -1;
}

function last4(raw: string | null): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : null;
}

/**
 * Read a label's value.
 *
 * The value is whatever follows the label on its own line, or — when the label
 * is the whole line, as in Axis's layout — the next non-empty line. Only text
 * *after* the label counts: "Axis Bank Credit Card No." has "Axis Bank" before
 * the matched words, and that prefix is not the value.
 */
function labelled(body: string, label: RegExp): string | null {
  const lines = body.split("\n").map((l) => l.trim());

  for (let i = 0; i < lines.length; i++) {
    const m = label.exec(lines[i]!);
    if (!m) continue;
    // Everything after the matched label text, whatever groups it contains.
    const inline = lines[i]!.slice(m.index + m[0].length).replace(/^[:.\s]+/, "").trim();
    // Punctuation-only remainders ("No." leaves ".") are not the value.
    if (inline && /[A-Za-z0-9]/.test(inline)) return inline;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!) return lines[j]!;
    }
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The profiles
// ---------------------------------------------------------------------------

const axisAccount: AlertProfile = {
  bank: "axis",
  senders: [/^alerts@axis\.bank\.in$/i],
  parse(subject, body) {
    // Distinguish the account alert from the card alert by its labels.
    const amountText = labelled(body, /Amount (Debited|Credited)/i);
    if (!amountText) return null;

    const amount = parseAlertAmount(amountText);
    const when = labelled(body, /Date & Time/i) ?? "";
    const date = parseAlertDate(when);
    if (amount === null || !date) return null;

    const sign = /Credited/i.test(body.match(/Amount (Debited|Credited)/i)?.[0] ?? "") ? 1 : -1;
    const narration = labelled(body, /Transaction Info/i) ?? subject;
    const account = labelled(body, /Account Number/i);

    return {
      amount: (sign * amount) as Paise,
      date, when,
      accountLast4: last4(account),
      cardLast4: null,
      narration,
      reference: extractReference(narration),
      cardholderName: greetedName(body),
      balance: null,
    };
  },
};

const axisCard: AlertProfile = {
  bank: "axis",
  senders: [/^alerts@axis\.bank\.in$/i],
  parse(subject, body) {
    const amountText = labelled(body, /Transaction Amount/i);
    if (!amountText) return null; // it is an account alert, not a card one

    const amount = parseAlertAmount(amountText);
    const when = labelled(body, /Date & Time/i) ?? "";
    const date = parseAlertDate(when);
    if (amount === null || !date) return null;

    const merchant = labelled(body, /Merchant Name/i) ?? subject;
    const card = labelled(body, /Credit Card No/i);
    const bal = labelled(body, /Available Limit/i);

    return {
      amount: (-amount) as Paise, // a card alert is always a spend
      date, when,
      accountLast4: null,
      cardLast4: last4(card),
      narration: merchant,
      reference: null,
      cardholderName: greetedName(body),
      balance: bal ? (parseAlertAmount(bal) as Paise) : null,
    };
  },
};

const yesCard: AlertProfile = {
  bank: "yes",
  senders: [/^alerts@yes\.bank\.in$/i],
  parse(_subject, body) {
    // "INR 70.00 has been spent on your YES BANK Credit Card ending with 8803
    //  at UPI_DESI BITES FAST FO on 27-08-2026 at 06:46:36 pm. Avl Bal INR …"
    const flat = body.replace(/\s+/g, " ");
    const m = /(INR\s*[\d,]+(?:\.\d{1,2})?)\s+has been (spent|debited|credited)\b[\s\S]*?ending with\s+(\d{4})\s+at\s+([\s\S]+?)\s+on\s+(\d{1,2}[-/][\w]{2,9}[-/]\d{2,4})\s+at\s+([\d:]+\s*[ap]m)/i
      .exec(flat);
    if (!m) return null;

    const amount = parseAlertAmount(m[1]!);
    const date = parseAlertDate(m[5]!);
    if (amount === null || !date) return null;

    const balMatch = /Avl Bal\s*(INR\s*[\d,]+(?:\.\d{1,2})?)/i.exec(flat);
    const sign = m[2]!.toLowerCase() === "credited" ? 1 : -1;
    return {
      amount: (sign * amount) as Paise,
      date, when: `${m[5]} ${m[6]!.trim()}`,
      accountLast4: null,
      cardLast4: m[3]!,
      narration: m[4]!.trim(),
      reference: extractReference(m[4]!),
      cardholderName: null,
      balance: balMatch ? (parseAlertAmount(balMatch[1]!) as Paise) : null,
    };
  },
};

const indusind: AlertProfile = {
  bank: "indusind",
  senders: [/@indusind\.com$/i],
  parse(subject, body) {
    // "Account No. 15XXXXXX6620 has been Debited for INR 1.00 towards
    //  UPI/400111222333/DR/Moj/YESB0PTMUPI/-72704731@ptyb"
    const flat = body.replace(/\s+/g, " ");
    const m = /Account No\.?\s*([\dxX*]+?\d{4}).*?has been (Debited|Credited)\s+for\s+(INR\s*[\d,]+(?:\.\d{1,2})?)\s+towards\s+(.+?)(?:\.|$)/is
      .exec(flat);
    if (!m) return null;

    const amount = parseAlertAmount(m[3]!);
    if (amount === null) return null;

    const sign = m[2]!.toLowerCase() === "credited" ? 1 : -1;
    const date = parseAlertDate(subject) ?? dateFromReceived(body);
    // "The balance available in your Account is INR 171.95" — the same
    // reconciliation hint the other banks give, and it was being dropped.
    const bal = /balance available in your Account is\s*(INR\s*[\d,]+(?:\.\d{1,2})?)/i.exec(flat);
    return {
      amount: (sign * amount) as Paise,
      date: date ?? ("" as IsoDate),
      when: "",
      accountLast4: m[1]!.slice(-4),
      cardLast4: null,
      narration: m[4]!.trim(),
      reference: extractReference(m[4]!),
      cardholderName: null,
      balance: bal ? (parseAlertAmount(bal[1]!) as Paise) : null,
    };
  },
};

const axisSentence: AlertProfile = {
  bank: "axis",
  senders: [/^alerts@axis\.bank\.in$/i],
  parse(_subject, body) {
    // NEFT and IMPS come as one sentence, not the label/value summary:
    //   "We wish to inform you that your A/c no. XX8457 has been debited with
    //    INR 23000.00 on 16-09-2026 06:17:07 IST by NEFT/MB/AXOMB25…/V. To
    //    check your available balance, please click here."
    // The narration runs to the sentence's full stop — which is also the
    // decimal separator's character, so it ends at ". " or the line's end.
    const flat = body.replace(/\s+/g, " ");
    const m =
      /your A\/c no\.?\s*[xX*]*(\d{4})\s+has been (debited|credited) with\s+(INR\s*[\d,]+(?:\.\d{1,2})?)\s+on\s+(\d{1,2}-\d{1,2}-\d{4}(?:\s+[\d:]+)?(?:\s*IST)?)\s+by\s+(.+?)(?:\.\s|\.$|$)/i
        .exec(flat);
    if (!m) return null;

    const amount = parseAlertAmount(m[3]!);
    const date = parseAlertDate(m[4]!);
    if (amount === null || !date) return null;

    const sign = m[2]!.toLowerCase() === "credited" ? 1 : -1;
    return {
      amount: (sign * amount) as Paise,
      date, when: m[4]!,
      accountLast4: m[1]!,
      cardLast4: null,
      narration: m[5]!.trim(),
      reference: extractReference(m[5]!),
      cardholderName: greetedName(body),
      balance: null,
    };
  },
};

const sbiCard: AlertProfile = {
  bank: "sbicard",
  senders: [/@sbicard\.com$/i],
  parse(_subject, body) {
    // "Rs.591.00 spent on your SBI Credit Card ending 6779 at
    //  MSPRETAILPRIVATELIMITE on 05/09/26."
    // Rupees rather than INR, a two-digit year, and the merchant runs to the
    // " on " before the date — which merchant names themselves never contain
    // because SBI strips the spaces out of them.
    const flat = body.replace(/\s+/g, " ");
    const m =
      /(Rs\.?\s*[\d,]+(?:\.\d{1,2})?)\s+(spent|debited|credited|refunded)\s+on your[^.]*?ending\s+(\d{4})\s+at\s+(.+?)\s+on\s+(\d{1,2}\/\d{1,2}\/\d{2,4})/i
        .exec(flat);
    if (!m) return null;

    const amount = parseAlertAmount(m[1]!);
    const date = parseAlertDate(m[5]!.replace(/\//g, "-"));
    if (amount === null || !date) return null;

    const sign = /credited|refunded/i.test(m[2]!) ? 1 : -1;
    return {
      amount: (sign * amount) as Paise,
      date, when: m[5]!,
      accountLast4: null,
      cardLast4: m[3]!,
      narration: m[4]!.trim(),
      reference: null,
      cardholderName: greetedName(body),
      balance: null,
    };
  },
};

export const ALERT_PROFILES: AlertProfile[] = [
  axisCard, axisAccount, axisSentence, yesCard, sbiCard, indusind,
];

/**
 * Parse an alert, trying each profile whose sender matches.
 *
 * `receivedDate` is the message's own date, used when the body carries a time
 * but no date (some IndusInd alerts).
 */
export function parseAlert(
  sender: string, subject: string, body: string, receivedDate?: IsoDate,
): { record: AlertRecord; bank: string } | null {
  for (const profile of ALERT_PROFILES) {
    if (!profile.senders.some((s) => s.test(sender.trim()))) continue;
    const record = profile.parse(subject, body);
    if (record) {
      if (!record.date && receivedDate) record.date = receivedDate;
      if (record.date) return { record, bank: profile.bank };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** The name in "Dear <name>," — the cardholder, which may be an add-on holder. */
function greetedName(body: string): string | null {
  // A word of the name may be a bare initial — "Kavya R Pillai".
  const m = /Dear\s+([A-Z][A-Za-z]*\.?(?:\s+[A-Z][A-Za-z]*\.?){0,3})\s*,/.exec(body);
  const name = m?.[1]?.trim();
  return name && !/^(customer|cardholder|sir|madam|user)$/i.test(name) ? name : null;
}

function extractReference(narration: string): string | null {
  const m = /\b(\d{9,20})\b/.exec(narration);
  return m ? m[1]! : null;
}

function dateFromReceived(body: string): IsoDate | null {
  const m = /\b(\d{1,2}[-/][A-Za-z0-9]{2,9}[-/]\d{2,4})\b/.exec(body);
  return m ? parseAlertDate(m[1]!) : null;
}
