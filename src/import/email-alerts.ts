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
  /**
   * The date and time as the alert wrote them — the raw date (P4 / I1). Empty
   * when the alert carries no date and the message's received date stood in.
   */
  when: string;
  /** The amount as the alert wrote it, "INR 600.00" — the raw amount. */
  rawAmount: string;
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
  /**
   * The same senders as the Gmail search names them. Spelled out rather than
   * derived from `senders`, because a pattern covering two domains has no
   * single address to strip it down to.
   */
  query: string[];
  parse: (subject: string, body: string) => AlertRecord | null;
}

/**
 * IMPORT-SND-3 · Axis moved its alerts from alerts@axisbank.com to
 * alerts@axis.bank.in in 2025; a year of the older ones were never read.
 */
const AXIS_ALERTS = [/^alerts@axis(\.bank\.in|bank\.com)$/i];
const AXIS_QUERY = ["alerts@axis.bank.in", "alerts@axisbank.com"];

// ---------------------------------------------------------------------------
// Shared field readers
// ---------------------------------------------------------------------------

/**
 * `28-08-26`, `28-08-2026`, `27-08-2026`, `27 Aug 2026`, `27-Aug-26`.
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
  // IMPORTS-SCHEDULES-34 · A two-digit year too, as the statement reader
  // takes one. YES Bank writes "27-Aug-26"; its profile matched the alert and
  // then this answered null, and the spend was dropped without a word.
  const named = /(\d{1,2})[-\s]([A-Za-z]{3})[a-z]*[-\s](\d{4}|\d{2})\b/.exec(raw);
  if (named) {
    const month = monthFromName(named[2]!);
    if (month !== null) return calendarDate(fullYear(named[3]!), month, Number(named[1]));
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
  senders: AXIS_ALERTS,
  query: AXIS_QUERY,
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
      date, when, rawAmount: amountText,
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
  senders: AXIS_ALERTS,
  query: AXIS_QUERY,
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
      date, when, rawAmount: amountText,
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
  senders: [/^alerts@yes(\.bank\.in|bank\.in)$/i],
  query: ["alerts@yes.bank.in", "alerts@yesbank.in"],
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
      date, when: `${m[5]} ${m[6]!.trim()}`, rawAmount: m[1]!,
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
  query: ["@indusind.com"],
  parse(subject, body) {
    // "Account No. 15XXXXXX6620 has been Debited for INR 1.00 towards
    //  UPI/400111222333/DR/Moj/YESB0PTMUPI/-12345678@ptyb"
    const flat = body.replace(/\s+/g, " ");
    // The narration runs to the sentence's full stop — ". " or the end — not
    // the first dot: a UPI handle such as "swiggy.stores@icici" has one.
    const m = /Account No\.?\s*([\dxX*]+?\d{4}).*?has been (Debited|Credited)\s+for\s+(INR\s*[\d,]+(?:\.\d{1,2})?)\s+towards\s+(.+?)(?:\.\s|\.$|$)/is
      .exec(flat);
    if (!m) return null;

    const amount = parseAlertAmount(m[3]!);
    if (amount === null) return null;

    const sign = m[2]!.toLowerCase() === "credited" ? 1 : -1;
    const date = parseAlertDate(subject) ?? dateFromReceived(body);
    const dateText = ALERT_DATE_TEXT.exec(subject)?.[0] ?? ALERT_DATE_TEXT.exec(body)?.[0] ?? "";
    // "The balance available in your Account is INR 171.95" — the same
    // reconciliation hint the other banks give, and it was being dropped.
    const bal = /balance available in your Account is\s*(INR\s*[\d,]+(?:\.\d{1,2})?)/i.exec(flat);
    return {
      amount: (sign * amount) as Paise,
      date: date ?? ("" as IsoDate),
      when: date ? dateText : "",
      rawAmount: m[3]!,
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
  senders: AXIS_ALERTS,
  query: AXIS_QUERY,
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
      date, when: m[4]!, rawAmount: m[3]!,
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
  query: ["@sbicard.com"],
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
      date, when: m[5]!, rawAmount: m[1]!,
      accountLast4: null,
      cardLast4: m[3]!,
      narration: m[4]!.trim(),
      reference: null,
      cardholderName: greetedName(body),
      balance: null,
    };
  },
};

/**
 * IMPORT-SND-4 · HDFC credit card. Three wordings in three years, all one
 * sentence, all from alerts@hdfcbank.net and then alerts@hdfcbank.bank.in:
 *
 *   "… using your HDFC Bank Credit Card ending 1111 for Rs 459.00 at SWIGGY
 *    on 01-12-2024 12:48:20."                                     (2024)
 *   "Rs.232.00 is debited from your HDFC Bank Credit Card ending 1111
 *    towards PayU*Swiggy Limited on 31 Aug, 2025 at 18:57:59."    (2025)
 *   "Rs. 203.00 has been debited from your HDFC Bank Credit Card ending 1111
 *    towards RAZ*Swiggy on 31 May, 2026 at 16:22:53."             (2026)
 */
const hdfcCard: AlertProfile = {
  bank: "hdfc",
  senders: [/^alerts@hdfcbank\.(bank\.in|net)$/i],
  query: ["alerts@hdfcbank.bank.in", "alerts@hdfcbank.net"],
  parse(_subject, body) {
    const flat = body.replace(/\s+/g, " ");
    const DATE = String.raw`(\d{1,2}[-/]\d{1,2}[-/]\d{2,4}|\d{1,2} [A-Za-z]{3,9},? \d{4})`;
    const TIME = String.raw`(?:\s+(?:at\s+)?(\d{1,2}:\d{2}(?::\d{2})?))?`;
    const older = new RegExp(
      String.raw`Credit Card ending\s+(\d{4})\s+for\s+(Rs\.?\s*[\d,]+(?:\.\d{1,2})?)\s+at\s+(.+?)\s+on\s+` + DATE + TIME, "i",
    ).exec(flat);
    const newer = older ? null : new RegExp(
      String.raw`(Rs\.?\s*[\d,]+(?:\.\d{1,2})?)\s+(?:is|has been)\s+(debited|credited)\s+(?:from|to)\s+your HDFC Bank Credit Card ending\s+(\d{4})\s+(?:towards|from|by)\s+(.+?)\s+on\s+` + DATE + TIME, "i",
    ).exec(flat);
    if (!older && !newer) return null;

    const [rawAmount, card, merchant, dateText, time, sign] = older
      ? [older[2]!, older[1]!, older[3]!, older[4]!, older[5], -1]
      : [newer![1]!, newer![3]!, newer![4]!, newer![5]!, newer![6], /credited/i.test(newer![2]!) ? 1 : -1];
    const amount = parseAlertAmount(rawAmount);
    const date = parseAlertDate(dateText.replace(",", ""));
    if (amount === null || !date) return null;

    return {
      amount: (sign * amount) as Paise,
      date, when: time ? `${dateText} ${time}` : dateText, rawAmount,
      accountLast4: null,
      cardLast4: card,
      narration: merchant.trim(),
      reference: null,
      cardholderName: greetedName(body),
      balance: null,
    };
  },
};

/**
 * IMPORT-SND-5 · ICICI credit card, from credit_cards@icicibank.com and then
 * cards@icici.bank.in. A spend names the date month-first:
 *
 *   "Your ICICI Bank Credit Card XX1111 has been used for a transaction of
 *    INR 1,528.00 on Apr 10, 2026 at 06:36:10. Info: FLIPKART INTERNET PVT."
 *
 * and a standing instruction that has gone through says so after the fact:
 *
 *   "We have successfully processed your payment of INR 1499.00 towards
 *    Amazon, with Standing Instruction Y00000, on 19/10/2026, through your
 *    ICICI Bank Credit Card 1111."
 *
 * The *upcoming* standing-instruction notice is not a transaction and is left
 * alone — see `NOT_YET_A_TRANSACTION`.
 */
const iciciCard: AlertProfile = {
  bank: "icici",
  senders: [/^(credit_)?cards@icici(\.bank\.in|bank\.com)$/i],
  query: ["cards@icici.bank.in", "credit_cards@icici.bank.in", "credit_cards@icicibank.com"],
  parse(_subject, body) {
    const flat = body.replace(/\s+/g, " ");
    const spend =
      /Credit Card\s+[xX*]*(\d{4})\s+has been used for a transaction of\s+(INR\s*[\d,]+(?:\.\d{1,2})?)\s+on\s+([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{4})(?:\s+at\s+([\d:]+))?\.?\s*(?:Info:\s*(.+?)\.(?:\s|$))?/i
        .exec(flat);
    if (spend) {
      const amount = parseAlertAmount(spend[2]!);
      const month = monthFromName(spend[3]!.slice(0, 3));
      const date = month === null ? null : calendarDate(Number(spend[5]), month, Number(spend[4]));
      if (amount === null || !date) return null;
      const when = `${spend[3]} ${spend[4]}, ${spend[5]}${spend[6] ? ` ${spend[6]}` : ""}`;
      return {
        amount: (-amount) as Paise,
        date, when, rawAmount: spend[2]!,
        accountLast4: null,
        cardLast4: spend[1]!,
        narration: (spend[7] ?? "ICICI Bank Credit Card").trim(),
        reference: null,
        cardholderName: greetedName(body),
        balance: null,
      };
    }

    const standing =
      /successfully processed your payment of\s+(INR\s*[\d,]+(?:\.\d{1,2})?)\s+towards\s+(.+?),\s*with Standing Instruction\s+(\S+?),\s*on\s+(\d{1,2}\/\d{1,2}\/\d{2,4}),\s*through your ICICI Bank Credit Card\s+[xX*]*(\d{4})/i
        .exec(flat);
    if (!standing) return null;
    const amount = parseAlertAmount(standing[1]!);
    const date = parseAlertDate(standing[4]!.replace(/\//g, "-"));
    if (amount === null || !date) return null;
    return {
      amount: (-amount) as Paise,
      date, when: standing[4]!, rawAmount: standing[1]!,
      accountLast4: null,
      cardLast4: standing[5]!,
      narration: standing[2]!.trim(),
      reference: standing[3]!,
      cardholderName: null,
      balance: null,
    };
  },
};

/**
 * IMPORT-SND-6 · Axis credit card before the label/value layout (to 2025):
 *
 *   "Thank you for using your credit card no. XX1111 for INR 649 at FZ Gifts
 *    Pv on 31-12-2024 15:21:26 IST."
 */
const axisCardSentence: AlertProfile = {
  bank: "axis",
  senders: AXIS_ALERTS,
  query: AXIS_QUERY,
  parse(_subject, body) {
    const flat = body.replace(/\s+/g, " ");
    const m =
      /using your credit card no\.?\s*[xX*]*(\d{4})\s+for\s+(INR\s*[\d,]+(?:\.\d{1,2})?)\s+at\s+(.+?)\s+on\s+(\d{1,2}-\d{1,2}-\d{2,4}(?:\s+[\d:]+)?(?:\s*IST)?)/i
        .exec(flat);
    if (!m) return null;
    const amount = parseAlertAmount(m[2]!);
    const date = parseAlertDate(m[4]!);
    if (amount === null || !date) return null;
    const limit = /available limit is now\s*(INR\s*[\d,]+(?:\.\d{1,2})?)/i.exec(flat);
    return {
      amount: (-amount) as Paise,
      date, when: m[4]!, rawAmount: m[2]!,
      accountLast4: null,
      cardLast4: m[1]!,
      narration: m[3]!.trim(),
      reference: null,
      cardholderName: greetedName(body),
      balance: limit ? (parseAlertAmount(limit[1]!) as Paise) : null,
    };
  },
};

/**
 * IMPORT-SND-7 · IndusInd credit card, from transactionalert@indusind.com —
 * the account profile above reads only the account sentence:
 *
 *   "The transaction on your IndusInd Bank Credit Card ending 1111 for
 *    INR 226.80 on 12-04-2025 09:49:46 pm at Zomato Ltd is Approved."
 */
const indusindCard: AlertProfile = {
  bank: "indusind",
  senders: [/@indusind\.com$/i],
  query: ["@indusind.com"],
  parse(_subject, body) {
    const flat = body.replace(/\s+/g, " ");
    const m =
      /transaction on your IndusInd Bank Credit Card ending\s+(\d{4})\s+for\s+(INR\s*[\d,]+(?:\.\d{1,2})?)\s+on\s+(\d{1,2}-\d{1,2}-\d{2,4}(?:\s+[\d:]+(?:\s*[ap]m)?)?)\s+at\s+(.+?)\s+is\s+(Approved|Declined)/i
        .exec(flat);
    if (!m || /declined/i.test(m[5]!)) return null; // a declined card moved no money
    const amount = parseAlertAmount(m[2]!);
    const date = parseAlertDate(m[3]!);
    if (amount === null || !date) return null;
    return {
      amount: (-amount) as Paise,
      date, when: m[3]!, rawAmount: m[2]!,
      accountLast4: null,
      cardLast4: m[1]!,
      narration: m[4]!.trim(),
      reference: null,
      cardholderName: null,
      balance: null,
    };
  },
};

/**
 * IMPORT-SND-8 · Standard Chartered card, from alerts.in@sc.com. The one
 * transaction shape seen is a payment received, dated in the alert's header:
 *
 *   "Email Alerts August 06 2025, 05:08 PM … We have received your payment of
 *    INR 270.00 towards your credit card number ending 1111."
 */
const scCard: AlertProfile = {
  bank: "sc",
  senders: [/^alerts\.in@sc\.com$/i],
  query: ["alerts.in@sc.com"],
  parse(_subject, body) {
    const flat = body.replace(/\s+/g, " ");
    const m =
      /received your payment of\s+(INR\s*[\d,]+(?:\.\d{1,2})?)\s+towards your credit card number ending\s+(\d{4})/i
        .exec(flat);
    if (!m) return null;
    const amount = parseAlertAmount(m[1]!);
    const head = /Email Alerts\s+([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})(?:,\s*([\d:]+\s*[AP]M))?/i.exec(flat);
    const month = head ? monthFromName(head[1]!.slice(0, 3)) : null;
    const date = head && month !== null ? calendarDate(Number(head[3]), month, Number(head[2])) : null;
    if (amount === null) return null;
    return {
      amount: amount as Paise, // a payment towards the card is a credit to it
      date: date ?? ("" as IsoDate),
      when: head ? head[0].replace(/^Email Alerts\s+/i, "") : "",
      rawAmount: m[1]!,
      accountLast4: null,
      cardLast4: m[2]!,
      narration: "Payment received",
      reference: null,
      cardholderName: null,
      balance: null,
    };
  },
};

/**
 * IMPORT-SND-9 · RBL credit card, from RBLAlerts@rbl.bank.in. Its statements
 * were fetched from that domain already, but its alerts had no profile:
 *
 *   "INR338.00 spent at PYU*SWIGGY FOOD on RBL Bank credit card (1111) on
 *    21-04-2026.AVL limit- INR67,662.00."
 *
 * A payment names only the card's last two digits, too few to place it on an
 * account, so it is read without a card and left for Review to place.
 */
const rblCard: AlertProfile = {
  bank: "rbl",
  senders: [/^rblalerts@rbl\.bank\.in$/i],
  query: ["rblalerts@rbl.bank.in"],
  parse(_subject, body) {
    const flat = body.replace(/\s+/g, " ");
    const spend =
      /(INR\s*[\d,]+(?:\.\d{1,2})?)\s+spent at\s+(.+?)\s+on RBL Bank credit card\s*\((\d{4})\)\s+on\s+(\d{1,2}-\d{1,2}-\d{4})/i
        .exec(flat);
    const paid = spend ? null :
      /payment of\s+(Rs\.?\s*[\d,]+(?:\.\d{1,2})?)\s+has been received towards your RBL Bank Credit Card[^.]*?\s+on\s+(\d{1,2}-\d{1,2}-\d{4})/i
        .exec(flat);
    if (!spend && !paid) return null;

    const rawAmount = spend ? spend[1]! : paid![1]!;
    const when = spend ? spend[4]! : paid![2]!;
    const amount = parseAlertAmount(rawAmount);
    const date = parseAlertDate(when);
    if (amount === null || !date) return null;
    return {
      amount: (spend ? -amount : amount) as Paise,
      date, when, rawAmount,
      accountLast4: null,
      cardLast4: spend ? spend[3]! : null,
      narration: spend ? spend[2]!.trim() : "Payment received",
      reference: null,
      cardholderName: spend ? null : greetedName(body),
      balance: null,
    };
  },
};

/**
 * IMPORT-SND-10 · HSBC credit card, from hsbc@mail.hsbc.co.in, unchanged
 * 2024-26:
 *
 *   "your Credit card no ending with 1111,has been used for INR 3992.00 for
 *    payment to Yatra Online Private Limi on 22 Jul 2024 at 14:01."
 */
const hsbcCard: AlertProfile = {
  bank: "hsbc",
  senders: [/^hsbc@mail\.hsbc\.co\.in$/i],
  query: ["hsbc@mail.hsbc.co.in"],
  parse(_subject, body) {
    const flat = body.replace(/\s+/g, " ");
    const m =
      /Credit card no ending with\s+(\d{4})\s*,\s*has been used for\s+(INR\s*[\d,]+(?:\.\d{1,2})?)\s+for payment to\s+(.+?)\s+on\s+(\d{1,2} [A-Za-z]{3,9} \d{4})(?:\s+at\s+([\d:]+))?/i
        .exec(flat);
    if (!m) return null;
    const amount = parseAlertAmount(m[2]!);
    const date = parseAlertDate(m[4]!);
    if (amount === null || !date) return null;
    return {
      amount: (-amount) as Paise,
      date, when: m[5] ? `${m[4]} ${m[5]}` : m[4]!, rawAmount: m[2]!,
      accountLast4: null,
      cardLast4: m[1]!,
      narration: m[3]!.trim(),
      reference: null,
      cardholderName: null,
      balance: null,
    };
  },
};

/**
 * IMPORT-SND-11 · Canara credit card, from noreply@canarabank.com:
 *
 *   "INR 2,074.60 spent on CanaraBank CreditCard XX1111: KATTAZHIKOM FUELS on
 *    31-AUG-26 17:51:42.Ref.001989 ."                              (2026)
 *   "Rs 1,988.08 spent on your Canara card ************1111 at AMAZON PAY
 *    INDIA PRIVA on 08-NOV-25 at 14:52:27."                        (2025)
 */
const canaraCard: AlertProfile = {
  bank: "canara",
  senders: [/^noreply@canarabank\.com$/i],
  query: ["noreply@canarabank.com"],
  parse(_subject, body) {
    const flat = body.replace(/\s+/g, " ");
    const m =
      /((?:INR|Rs\.?)\s*[\d,]+(?:\.\d{1,2})?)\s+spent on (?:CanaraBank CreditCard|your Canara card)\s+[xX*]*(\d{4})\s*(?::|\s+at)\s*(.+?)\s+on\s+(\d{1,2}-[A-Za-z]{3}-\d{2,4})(?:\s+(?:at\s+)?([\d:]+))?(?:\.?\s*Ref\.?\s*(\w+))?/i
        .exec(flat);
    if (!m) return null;
    const amount = parseAlertAmount(m[1]!);
    const date = parseAlertDate(m[4]!);
    if (amount === null || !date) return null;
    return {
      amount: (-amount) as Paise,
      date, when: m[5] ? `${m[4]} ${m[5]}` : m[4]!, rawAmount: m[1]!,
      accountLast4: null,
      cardLast4: m[2]!,
      narration: m[3]!.trim(),
      reference: m[6] ?? null,
      cardholderName: null,
      balance: null,
    };
  },
};

export const ALERT_PROFILES: AlertProfile[] = [
  axisCard, axisAccount, axisSentence, axisCardSentence, yesCard, sbiCard, indusind, indusindCard,
  hdfcCard, iciciCard, scCard, rblCard, hsbcCard, canaraCard,
];

/**
 * A notice that names an amount and "debited" but has not happened yet —
 * ICICI's "will be debited from your … Credit Card" before a standing
 * instruction runs. It is not a transaction, and it is not an alert that could
 * not be read either.
 */
const NOT_YET_A_TRANSACTION = /\bwill be (?:debited|charged|deducted)\b|\bis due on\b/i;

/**
 * Some alerts reach us with the space between "INR" and the amount as a
 * non-breaking space in a charset the message did not declare, which decodes
 * to U+FFFD: Axis's card alert reads "INR�385". Both are a space here.
 */
function normaliseSpaces(text: string): string {
  return text.replace(/[ �]/g, " ");
}

/**
 * Parse an alert, trying each profile whose sender matches.
 *
 * `receivedDate` is the message's own date, used when the body carries a time
 * but no date (some IndusInd alerts).
 */
export function parseAlert(
  sender: string, subject: string, body: string, receivedDate?: IsoDate,
): { record: AlertRecord; bank: string } | null {
  const text = normaliseSpaces(body);
  for (const profile of ALERT_PROFILES) {
    if (!profile.senders.some((s) => s.test(sender.trim()))) continue;
    const record = profile.parse(subject, text);
    if (record) {
      if (!record.date && receivedDate) record.date = receivedDate;
      if (record.date) return { record, bank: profile.bank };
    }
  }
  return null;
}

/**
 * IMPORTS-SCHEDULES-34 · A message from an alert sender that reads like a
 * transaction — an amount and "spent", "debited", "credited" — but that no
 * profile could read. Such a message was dropped without a word; the fetch
 * now says one was left unread. Promotions and OTPs from the same senders
 * name no such verb beside an amount, and stay quiet.
 */
export function looksLikeUnreadAlert(sender: string, body: string): boolean {
  if (!ALERT_PROFILES.some((p) => p.senders.some((s) => s.test(sender.trim())))) return false;
  const flat = normaliseSpaces(body).replace(/\s+/g, " ");
  if (NOT_YET_A_TRANSACTION.test(flat)) return false;
  return /(?:INR|Rs\.?|₹)\s*[\d,]+/i.test(flat)
    && /\b(?:spent|debited|credited|refunded|withdrawn)\b/i.test(flat);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** The name in "Dear <name>," — the cardholder, which may be an add-on holder. */
function greetedName(body: string): string | null {
  // A word of the name may be a bare initial — "Kavya R Pillai".
  const m = /Dear\s+([A-Z][A-Za-z]*\.?(?:\s+[A-Z][A-Za-z]*\.?){0,3})\s*,/.exec(body);
  const name = m?.[1]?.trim();
  return name && !/^(customer|card ?holder|card member|sir|madam|user)$/i.test(name) ? name : null;
}

function extractReference(narration: string): string | null {
  const m = /\b(\d{9,20})\b/.exec(narration);
  return m ? m[1]! : null;
}

/** A date written anywhere in an alert's subject or body, as text. */
const ALERT_DATE_TEXT = /\b(\d{1,2}[-/][A-Za-z0-9]{2,9}[-/]\d{2,4})\b/;

function dateFromReceived(body: string): IsoDate | null {
  const m = ALERT_DATE_TEXT.exec(body);
  return m ? parseAlertDate(m[1]!) : null;
}
