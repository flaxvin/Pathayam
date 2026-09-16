/**
 * `10` §3.6 · Statement password derivation, and the identity it needs.
 *
 * Indian banks do not let you choose a statement password. Each one derives it
 * from something they already know about you, and every bank picks a different
 * something:
 *
 *   · **Union Bank** — first four characters of your name in UPPERCASE, then
 *     DDMM. Stated verbatim in their own statement email.
 *   · **Axis** — the same, in lowercase.
 *   · **ICICI** — the same, lowercase, "no special characters, spaces or
 *     salutation".
 *   · **Upstox, INDmoney, most brokers** — the PAN, lowercase.
 *   · **SBI Card** — the date of birth as DDMMYYYY, then the card's last four.
 *   · **SBI account** — the last five of the registered mobile, then DDMMYY.
 *   · **Canara** — the card's last four, alone.
 *   · **HSBC** — the date of birth as DDMMYY, then the card's last six.
 *
 * The last four rules are quoted from each institution's own statement email,
 * and each needs a digit the name/PAN/DOB triple does not carry — a card
 * number (which the app already stores per account for SMS matching, F2.9) or
 * the registered mobile. Those are threaded in rather than assumed.
 *
 * So a household that wants unattended statement fetching (`04` §3.4) has to
 * let the app hold the name, the PAN and the date of birth. **This reverses
 * PR5**, which says statement passwords are used in memory for a single import
 * and never persisted. The reversal is deliberate, is recorded in `10` §3.6
 * with its cost, and is contained:
 *
 *   · It is **opt-in**. Everything works without it; the import screen simply
 *     asks for a password like it always did.
 *   · The values are **never exported** (`08` F15 exports the budget; this is
 *     not budget data and it travels), **never logged**, and shown masked.
 *   · The derived password is never stored — only the ingredients, and only
 *     because a household cannot be asked to retype a PAN twelve times a month.
 *
 * Nothing here writes to disk. Storage is `identity.ts`; this file is the
 * arithmetic.
 */

import type { BankId } from "./pdf-statements.ts";

export interface StatementIdentity {
  /** As printed on the statement, which is what the first-four rule uses. */
  name: string;
  /** Ten characters, e.g. ABCDE1234F. Case is normalised per candidate. */
  pan: string | null;
  /** DDMMYYYY, the form every bank's instructions use. */
  dob: string | null;
  /**
   * The registered mobile number, digits only. SBI's account statement uses
   * its last five; nothing else here needs it, so it stays optional.
   */
  mobile?: string | null;
}

/** The first four characters of a name, ignoring spaces and punctuation. */
export function nameKey(name: string): string {
  const letters = name.replace(/[^A-Za-z]/g, "");
  return letters.slice(0, 4);
}

function parts(dob: string | null): { dd: string; mm: string; yyyy: string } | null {
  if (!dob) return null;
  const digits = dob.replace(/\D/g, "");
  if (digits.length !== 8) return null;
  return { dd: digits.slice(0, 2), mm: digits.slice(2, 4), yyyy: digits.slice(4) };
}

/**
 * Every password this identity could produce, best guess first.
 *
 * A list rather than one answer, because the rules change: a bank that wanted
 * DDMM last year wants DDMMYYYY this year, and a household should not have to
 * care. Trying eight candidates against a local file costs nothing — there is
 * no server to rate-limit us and no account to lock.
 *
 * `bankId` only reorders the list. Every candidate is still tried, so a bank
 * that quietly changed its rule still opens.
 */
export function passwordCandidates(
  identity: StatementIdentity,
  bankId?: BankId | null,
  opts: { cardDigits?: (string | null | undefined)[] } = {},
): string[] {
  const key = nameKey(identity.name);
  const d = parts(identity.dob);
  const pan = identity.pan?.replace(/\s/g, "") ?? null;
  const mobile = identity.mobile?.replace(/\D/g, "") || null;

  // Every card/account number the app can offer, digits only. The account's
  // stored last-four (F2.9) is the usual one; the household may have typed a
  // fuller number, which unlocks HSBC's last-six.
  const numbers = (opts.cardDigits ?? [])
    .map((n) => (n ?? "").replace(/\D/g, ""))
    .filter((n) => n.length >= 4);
  const lastN = (n: number): string[] =>
    [...new Set(numbers.filter((x) => x.length >= n).map((x) => x.slice(-n)))];

  const all: string[] = [];
  const add = (value: string | null | undefined) => {
    if (value && !all.includes(value)) all.push(value);
  };

  if (d) {
    const ddmm = d.dd + d.mm;
    const ddmmyyyy = ddmm + d.yyyy;

    // The name+DDMM family, which most Indian banks use.
    add(key.toUpperCase() + ddmm);
    add(key.toLowerCase() + ddmm);
    add(key.charAt(0).toUpperCase() + key.slice(1).toLowerCase() + ddmm);

    // RBL uses a two-digit year: RAVI010170. Found by trying, not documented.
    add(key.toUpperCase() + ddmm + d.yyyy.slice(2));
    add(key.toLowerCase() + ddmm + d.yyyy.slice(2));

    add(ddmmyyyy);
    add(ddmm);
    add(d.yyyy + d.mm + d.dd);
    add(key.toUpperCase() + ddmmyyyy);
    add(key.toLowerCase() + ddmmyyyy);
  }

  /*
   * Card- and mobile-based rules, each quoted from the institution's own
   * statement, each needing a digit the name/PAN/DOB triple does not carry:
   *
   *   · SBI account — last five of the registered mobile, then DOB as DDMMYY.
   *       "mobile XXXXX12345 and DOB 16 Sept 1982 -> 12345160982"
   *   · SBI Card    — DOB as DDMMYYYY, then the last four of the card.
   *       "DOB 01.04.1980 & card 1234 -> 010419801234"
   *   · Canara      — the last four of the card, alone.
   *       "5111********5006 -> 5006"
   *   · HSBC        — DOB as DDMMYY, then the last six of the card.
   */
  if (d) {
    const ddmm = d.dd + d.mm;
    const ddmmyy = ddmm + d.yyyy.slice(2);
    const ddmmyyyy = ddmm + d.yyyy;

    if (mobile && mobile.length >= 5) add(mobile.slice(-5) + ddmmyy);      // SBI account
    for (const four of lastN(4)) {
      add(four);                                                           // Canara
      add(ddmmyyyy + four);                                                // SBI Card
      add(ddmmyy + four);
    }
    for (const six of lastN(6)) add(ddmmyy + six);                         // HSBC
  } else {
    // Canara needs only the card, so it works even with no date of birth.
    for (const four of lastN(4)) add(four);
  }

  if (pan) {
    add(pan.toLowerCase());
    add(pan.toUpperCase());
    if (d) {
      add(pan.toUpperCase() + d.dd + d.mm + d.yyyy);
      add(pan.toLowerCase() + d.dd + d.mm + d.yyyy);
      // Several brokers use the first five PAN letters with the DOB.
      add(pan.slice(0, 5).toUpperCase() + d.dd + d.mm + d.yyyy);
    }
  }

  // An unprotected statement is common enough to be worth trying first, and it
  // costs one attempt.
  const preferred = bankId ? (PREFERENCES[bankId] ?? []) : [];
  const ordered = [
    "",
    ...preferred.map((rule) => rule(identity)).filter((v): v is string => Boolean(v)),
    ...all,
  ];

  return [...new Set(ordered)];
}

type Rule = (identity: StatementIdentity) => string | null;

const nameUpperDdmm: Rule = (i) => {
  const d = parts(i.dob);
  return d ? nameKey(i.name).toUpperCase() + d.dd + d.mm : null;
};
const nameLowerDdmm: Rule = (i) => {
  const d = parts(i.dob);
  return d ? nameKey(i.name).toLowerCase() + d.dd + d.mm : null;
};
const dobFull: Rule = (i) => {
  const d = parts(i.dob);
  return d ? d.dd + d.mm + d.yyyy : null;
};
const panLower: Rule = (i) => i.pan?.toLowerCase() ?? null;

/**
 * What each bank says in its own statement email, tried first.
 *
 * Sourced from the emails themselves rather than from documentation, which is
 * why Union Bank's is uppercase and Axis's is lowercase — both are quoted
 * word-for-word in `BANKS[].passwordHint`.
 */
const PREFERENCES: Partial<Record<BankId, Rule[]>> = {
  axis: [nameLowerDdmm, nameUpperDdmm],
  icici: [nameLowerDdmm, nameUpperDdmm],
  union: [nameUpperDdmm, nameLowerDdmm],
  hdfc: [nameUpperDdmm, dobFull],
  sbi: [dobFull, nameUpperDdmm],
  canara: [dobFull, nameUpperDdmm],
  yes: [nameUpperDdmm, dobFull],
  indusind: [dobFull, nameUpperDdmm],
  kotak: [nameLowerDdmm, dobFull],
  broker: [panLower],
};

/**
 * Open a statement by trying each candidate in turn.
 *
 * Returns the parse and *which* candidate worked, so the caller can say "this
 * opened with your PAN" rather than leaving the household guessing. The
 * password itself is not returned — only a description of it.
 */
/**
 * Why nothing worked, when the reason is a detail the app does not have.
 *
 * Four of the twelve institutions in one household's inbox need a digit the
 * name + date of birth + PAN triple does not carry, and against a real corpus
 * they account for every single statement that could not be opened: SBI wants
 * the registered mobile, SBI Card and Canara the card's last four, HSBC its
 * last six. Told only "none of the passwords worked", a household has no way to
 * know that the fix is one field in Settings rather than a lost cause.
 *
 * Null when the bank is unknown, or when everything its rule needs is already
 * on file — then the password genuinely is something else, and saying otherwise
 * would send somebody to fill in a form that is already full.
 */
export function missingDetailFor(
  bankId: BankId | null | undefined,
  identity: StatementIdentity,
  cardDigits: (string | null | undefined)[] = [],
): string | null {
  const digits = cardDigits.map((d) => (d ?? "").replace(/\D/g, "")).filter(Boolean);
  const longest = digits.reduce((a, b) => (b.length > a.length ? b : a), "");
  const mobile = identity.mobile?.replace(/\D/g, "") ?? "";

  switch (bankId) {
    case "sbi":
      // Both SBI rules live under one id: the account statement wants the
      // mobile, the card statement the card. Name whichever is missing.
      if (mobile.length < 5 && longest.length < 4) {
        return "SBI needs either your registered mobile number (its account statements use "
          + "the last five digits) or the card's last four — add whichever applies in Settings.";
      }
      if (mobile.length < 5) {
        return "SBI's account statements use the last five digits of your registered mobile "
          + "number, which is not saved yet. Add it in Settings.";
      }
      if (longest.length < 4) {
        return "SBI Card statements use the card's last four digits, which this account does "
          + "not have recorded. Add them on the account.";
      }
      return null;
    case "canara":
      return longest.length < 4
        ? "Canara's card statements open with the card's last four digits alone, which this "
          + "account does not have recorded. Add them on the account."
        : null;
    case "hsbc":
      return longest.length < 6
        ? "HSBC uses the last six digits of the card, and this account has "
          + (longest.length > 0 ? "only the last four." : "no card number recorded.")
          + " Add the fuller number on the account."
        : null;
    default:
      return null;
  }
}

export function describeCandidate(
  candidate: string, identity: StatementIdentity,
): string {
  if (candidate === "") return "no password";
  if (identity.pan && candidate.toLowerCase() === identity.pan.toLowerCase()) {
    return "your PAN";
  }
  const key = nameKey(identity.name);
  if (key && candidate.toLowerCase().startsWith(key.toLowerCase())) {
    return "your name and date of birth";
  }
  return "your date of birth";
}
