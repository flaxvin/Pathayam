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
 *   · PAN numbers are masked whole.
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
const PAN = /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g;
// Nine or more digits, optionally grouped by spaces or hyphens (a card number
// written 4-4-4-4, a phone written +91 98xxx xxxxx).
const DIGIT_RUN = /(?<![\w])\+?\d(?:[ \-]?\d){8,}(?![\w])/g;

export function redactString(s: string): string {
  return s
    .replace(HANDLE, (_m, domain: string) => `•••@${domain}`)
    .replace(PAN, "•••••••••• (PAN)")
    .replace(DIGIT_RUN, (m) => {
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
