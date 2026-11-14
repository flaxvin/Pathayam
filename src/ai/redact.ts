/**
 * AI-3 · Redaction for what an AI connection is sent.
 *
 * Whatever a tool returns leaves the house: it goes to the AI provider and
 * into the model's context. A household that wants the analysis but not the
 * identifiers can ask for a connection to be redacted. Amounts, dates,
 * envelope and payee names stay — they are the analysis — while the strings
 * that identify a person or an account to somebody outside are masked:
 *
 *   · long digit runs (account and card numbers, phone numbers, Aadhaar,
 *     UPI reference numbers) keep only their last four digits;
 *   · UPI IDs and email addresses keep only the part after the @, which
 *     names the bank or provider, not the person;
 *   · PAN numbers are masked whole, in either case;
 *   · a number its label names (A/c, acct, Folio, CRN, Customer ID) keeps
 *     its last four digits even when it is shorter than nine digits, and a
 *     phone written with dots or brackets is masked like any other.
 *
 * Applied to string values only, and never to keys that are the app's own
 * identifiers (`id`, `*_id`, cursors) or to dates — masking those would break
 * the model's ability to ask a follow-up question about the same row, and
 * they identify nothing outside this database.
 *
 * Best-effort by nature: a narration can carry a name no pattern recognises.
 * The settings page says so rather than promising more than this does.
 */

const SKIP_KEY = /(^id$|_id$|^cursor$|^next_cursor$|_date$|^date$|^month$|^from$|^to$|_at$)/;

// Order matters: emails and UPI IDs first, so their digits are not half-masked
// by the digit rule and left looking like something else.
const HANDLE = /\b[\w.\-+]{2,}@([A-Za-z][\w\-]*(?:\.[\w\-]+)*)\b/g;
// Upper case as issued; lower case as people type it. The lower-case form
// also requires the fourth letter to be a PAN holder type (P person, C
// company, H HUF, F firm, A AOP, T trust, B BOI, L local authority,
// J juridical person, G government) so a word like "order1234x" is left be.
const PAN = /\b(?:[A-Z]{5}[0-9]{4}[A-Z]|[a-z]{3}[pchfatbljg][a-z][0-9]{4}[a-z])\b/g;
// An identifier its label names, which may be shorter than DIGIT_RUN's nine
// digits: "acct 1234-5678", "Folio 12345678/90", "CRN 87654321". The number
// must not run on into a decimal or a grouped figure, so "account 1234567.89"
// (an amount) is left alone.
const LABELLED = /\b(a\/c|acct|account|folio|crn|cust(?:omer)?\s*id|client\s*id)(\.?\s*(?:no\.?|number|#)?\s*[:#\-]?\s*)(\d[\d\/\-]*\d)(?![.,]?\d)/gi;
// A phone written with dots or brackets: "98765.43210", "987.654.3210",
// "(987) 654-3210". Every dot-separated group after the first must have at
// least three digits, so amounts ("12345678.90") and dates ("13.11.2026")
// are not phones.
const PHONE_PUNCT = /(?<![\d.])(?:\(\+?\d{1,5}\)\s?)?\d{2,5}(?:[ .\-]\d{2,5}){1,3}(?!\d|\.\d)/g;
// A date, optionally followed by the hour of a time, that DIGIT_RUN would
// otherwise read as one long number: "13-11-2026 10:32".
const DATE_LIKE = /^(?:\d{1,2}-\d{1,2}-\d{4}|\d{4}-\d{1,2}-\d{1,2})(?: \d{1,2})?$/;
// Nine or more digits, optionally grouped by spaces or hyphens (a card number
// written 4-4-4-4, a phone written +91 98xxx xxxxx). Bounded by digits only,
// not word characters (AI-2): banks glue a reference to their own letters —
// "IMPS412345678901", "MOB9876543210", a NEFT UTR "N123456789012" — and a
// word boundary left every one of those whole.
const DIGIT_RUN = /(?<!\d)\+?\d(?:[ \-]?\d){8,}(?!\d)/g;

export function redactString(s: string): string {
  return s
    .replace(HANDLE, (_m, domain: string) => `•••@${domain}`)
    .replace(PAN, "•••••••••• (PAN)")
    .replace(LABELLED, (m, label: string, sep: string, id: string) => {
      const digits = id.replace(/\D/g, "");
      return digits.length >= 6 ? `${label}${sep}••••${digits.slice(-4)}` : m;
    })
    .replace(PHONE_PUNCT, (m) => {
      if (!/[.()]/.test(m)) return m;
      if (m.split(".").slice(1).some((group) => !/^\d{3}/.test(group))) return m;
      const digits = m.replace(/\D/g, "");
      return digits.length >= 9 ? `••••${digits.slice(-4)}` : m;
    })
    .replace(DIGIT_RUN, (m) => {
      if (DATE_LIKE.test(m)) return m;
      const digits = m.replace(/\D/g, "");
      return `••••${digits.slice(-4)}`;
    });
}

/** Deep copy with every eligible string redacted. */
export function redactValue(value: unknown, key = ""): unknown {
  if (typeof value === "string") return SKIP_KEY.test(key) ? value : redactString(value);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, key));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactValue(v, k);
    return out;
  }
  return value;
}
