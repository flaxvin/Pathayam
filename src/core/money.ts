/**
 * Money — integer paise, always.
 *
 * Floating point never touches a rupee figure. Every amount in this app is a
 * whole number of paise held in a JS integer, which is exact to 2^53 paise
 * (about ₹90,07,19,92,54,740). The engine carries unrounded values and rounding
 * is display-only (`05` §7, `06` §12).
 *
 * Implements L1, L2, L11 of `02` §6.
 */

/** A whole number of paise. 100 paise = ₹1. */
export type Paise = number;

export const RUPEE = 100;

export function rupees(n: number): Paise {
  return Math.round(n * RUPEE);
}

export function isPaise(v: unknown): v is Paise {
  return typeof v === "number" && Number.isSafeInteger(v);
}

export function assertPaise(v: unknown, what = "amount"): Paise {
  if (!isPaise(v)) {
    throw new RangeError(`${what} must be a whole number of paise, got ${String(v)}`);
  }
  return v;
}

/**
 * Split `amount` into `parts` shares that sum to exactly `amount`.
 *
 * The remainder paise are distributed one each to the earliest parts, so the
 * result is deterministic and loses nothing. Used wherever the engine divides —
 * "savings by date" targets (R8), split transactions (F4.3), remainder sweeps.
 */
export function allocate(amount: Paise, parts: number): Paise[] {
  if (!Number.isInteger(parts) || parts <= 0) {
    throw new RangeError(`parts must be a positive integer, got ${parts}`);
  }
  const sign = amount < 0 ? -1 : 1;
  const abs = Math.abs(amount);
  const base = Math.floor(abs / parts);
  let remainder = abs - base * parts;
  const out: Paise[] = [];
  for (let i = 0; i < parts; i++) {
    const extra = remainder > 0 ? 1 : 0;
    remainder -= extra;
    out.push(sign * (base + extra));
  }
  return out;
}

/**
 * Divide by weights, summing to exactly `amount`. Used by remainder-sweep
 * auto-assign rules (R9), which distribute whatever RTA is left by weight.
 */
export function allocateByWeight(amount: Paise, weights: number[]): Paise[] {
  if (weights.length === 0) return [];
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return weights.map(() => 0);
  const out: Paise[] = [];
  let assigned = 0;
  for (let i = 0; i < weights.length - 1; i++) {
    const share = Math.trunc((amount * weights[i]!) / total);
    out.push(share);
    assigned += share;
  }
  out.push(amount - assigned);
  return out;
}

// ---------------------------------------------------------------------------
// Formatting — L1, L2, L11
// ---------------------------------------------------------------------------

/** Indian digit grouping: last three digits, then pairs. 1234567 -> "12,34,567" */
function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3);
  const pairs = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `${pairs},${last3}`;
}

export interface FormatOptions {
  /** Show the ₹ symbol. Default true. */
  symbol?: boolean;
  /**
   * Force two decimal places. Default false, which shows paise only when they
   * are non-zero (L11: "default to displaying whole rupees where paise are zero").
   */
  alwaysPaise?: boolean;
  /** Render a negative as "-₹1,200" rather than "₹-1,200". Default true. */
  signBeforeSymbol?: boolean;
}

/** ₹12,34,567.89 — the canonical display form (L1). */
export function formatPaise(amount: Paise, opts: FormatOptions = {}): string {
  const { symbol = true, alwaysPaise = false, signBeforeSymbol = true } = opts;
  /*
   * B77 · Round before splitting rupees from paise.
   *
   * Every amount in this app is an integer number of paise, and the `Paise`
   * brand exists to keep it that way — but a brand is a promise the compiler
   * checks, not one the runtime enforces, and a single `as Paise` on an average
   * was enough to put a fraction in here. The split then produced
   * "₹13,666.66.66666666674428" on the Overview.
   *
   * This is the last place a number becomes text, so it is the right place to
   * be defensive: a wrong amount is a bug worth finding, but an unreadable one
   * helps nobody.
   */
  const negative = amount < 0;
  const abs = Math.round(Math.abs(amount));
  const whole = Math.trunc(abs / RUPEE);
  const paise = abs - whole * RUPEE;

  let body = groupIndian(String(whole));
  if (alwaysPaise || paise !== 0) {
    body += `.${String(paise).padStart(2, "0")}`;
  }

  const sym = symbol ? "₹" : "";
  if (!negative) return `${sym}${body}`;
  return signBeforeSymbol ? `-${sym}${body}` : `${sym}-${body}`;
}

/**
 * Short form for tight space: ₹12.35L, ₹1.20Cr (L2).
 *
 * The exact figure must always be available on hover/tap — callers pair this
 * with `formatPaise` in a title attribute. Never use this alone for a figure
 * the user is expected to act on.
 */
export function formatCompact(amount: Paise): string {
  const negative = amount < 0;
  const abs = Math.abs(amount);
  const r = abs / RUPEE;
  const sign = negative ? "-" : "";

  if (r >= 1_00_00_000) return `${sign}₹${trimZeros(r / 1_00_00_000)}Cr`;
  if (r >= 1_00_000) return `${sign}₹${trimZeros(r / 1_00_000)}L`;
  if (r >= 1_000) return `${sign}₹${trimZeros(r / 1_000)}K`;
  return formatPaise(amount);
}

function trimZeros(n: number): string {
  return n.toFixed(2).replace(/\.?0+$/, "");
}

/**
 * Screen-reader form (A5): "₹" is announced as "R" by several screen readers,
 * so amounts are given an explicit spoken label.
 */
export function speakPaise(amount: Paise): string {
  const negative = amount < 0;
  const abs = Math.round(Math.abs(amount));
  const whole = Math.trunc(abs / RUPEE);
  const paise = abs - whole * RUPEE;

  const parts: string[] = [];
  const spoken = speakIndian(whole);
  parts.push(`${spoken} ${whole === 1 ? "rupee" : "rupees"}`);
  if (paise !== 0) parts.push(`${paise} paise`);
  return `${negative ? "minus " : ""}${parts.join(" ")}`;
}

/**
 * B95 · Say a number the way the rest of the app writes it.
 *
 * Everything on screen groups in the Indian system — `groupIndian` renders
 * ₹52,75,874 and `formatCompact` says ₹52.76L — and the screen-reader text
 * beside it said "5275874 rupees", which a reader renders in millions or spells
 * out digit by digit. Ready to Assign is the single most important figure on
 * the budget screen and it was the least intelligible one to anybody using it
 * by ear (A5).
 *
 * Lakh and crore are not separators here; they are how the number is said.
 */
function speakIndian(whole: number): string {
  if (whole < 1000) return String(whole);

  const crore = Math.trunc(whole / 10_000_000);
  const lakh = Math.trunc((whole % 10_000_000) / 100_000);
  const thousand = Math.trunc((whole % 100_000) / 1000);
  const rest = whole % 1000;

  const said: string[] = [];
  if (crore) said.push(`${crore} crore`);
  if (lakh) said.push(`${lakh} lakh`);
  if (thousand) said.push(`${thousand} thousand`);
  if (rest) said.push(String(rest));
  return said.join(" ");
}

// ---------------------------------------------------------------------------
// Parsing — accepts what an Indian keyboard actually produces
// ---------------------------------------------------------------------------

/**
 * Where a figure came from. It changes how an attached "Cr" is read.
 *
 * - `typed`: someone typed it into a form, where "1.2Cr" is crore shorthand.
 * - `statement`: a bank printed it, where "1,200.00Cr" is a credit of ₹1,200
 *   and no bank ever writes lakh or crore shorthand.
 */
export type AmountContext = "typed" | "statement";

// Figures carry their currency in front in every shape the household's banks
// and alerts use: "₹450", "Rs.450", "Rs. 450", "INR 450".
const CURRENCY_PREFIX = /^(?:₹|rs\.?|inr)\s*/i;

// A figure's rupee digits, grouped either way. Indian grouping puts pairs
// above the last three digits (12,34,567); Western puts triples (1,234,567).
// "1,23" and "1,2,3,4" are neither — a mangled cell, not a number to read
// around (the old reader stripped every comma and made them ₹123 and ₹1,234).
const UNGROUPED = /^\d*$/;
const INDIAN_GROUPS = /^\d{1,2}(?:,\d{2})*,\d{3}$/;
const WESTERN_GROUPS = /^\d{1,3}(?:,\d{3})+$/;

/**
 * Parse an amount into paise. Returns null on anything unparseable or
 * ambiguous — callers decide what to tell the user; this never throws on user
 * input.
 *
 * Accepts: "1234", "1,234", "12,34,567.89", "₹450", "Rs. 450", "INR 450",
 * "450.5", "−450" (the Unicode minus PDFs and phone keyboards produce),
 * "(450)" (accounting negative), the "Dr"/"Cr" markers Indian statements use
 * (`04` §3.2), and — typed only — "1.2L", "45k" and "3Cr".
 *
 * **The crore rule.** "Cr" means two things in India: a bank's credit marker
 * and crore. The old reader decided by whether a space came first, so
 * "1,200.00Cr" — how several banks print a ₹1,200 credit — came back as ₹120
 * crore, 10^7 times too much, while "1200DR" was refused outright. A wrong
 * amount by a factor of ten million is the worst thing this function can
 * return, so the rule refuses before it guesses:
 *
 * 1. "Dr" (any case, attached or spaced, with or without a dot) is always a
 *    debit marker.
 * 2. In a `statement`, "Cr" is always the credit marker, and L/K/Cr shorthand
 *    is never read — no bank writes it.
 * 3. When `typed`, "Cr" is the credit marker on a statement-shaped figure —
 *    one with digit grouping or four or more rupee digits ("1,200.00Cr",
 *    "1200CR"): nobody means ₹1,000 crore. It is crore shorthand on a figure
 *    of one or two rupee digits written straight against it ("3Cr",
 *    "1.25Cr"). Everything between ("450Cr", "3 Cr", "3Cr.") could be either,
 *    and is refused.
 *
 * Signs are counted too: "-450 Dr", "(450) Dr" and "(-450)" each say "minus"
 * twice — the old reader cancelled them and returned +₹450 — and whether that
 * was meant is a guess, so they are refused. More than two decimal places is
 * refused as well: "1.234" is not a number of paise, and rounding it to ₹1.23
 * hides a malformed cell.
 */
export function parseAmount(input: string, context: AmountContext = "typed"): Paise | null {
  let s = input.trim().replace(/−/g, "-");
  if (s === "") return null;

  let negatives = 0;
  let positives = 0;

  // Accounting-style parentheses: (450) is -450
  if (/^\(.*\)$/.test(s)) {
    negatives++;
    s = s.slice(1, -1).trim();
  }

  // The Dr / Cr marker, or crore shorthand, at the end.
  let crore = false;
  const mark = /(\s*)(cr|dr)(\.?)$/i.exec(s);
  if (mark) {
    s = s.slice(0, mark.index).trim();
    if (mark[2]!.toLowerCase() === "dr") {
      negatives++;
    } else if (context === "statement") {
      positives++;
    } else {
      const figure = s.replace(CURRENCY_PREFIX, "").replace(/^[-+]\s*/, "");
      const rupeeDigits = figure.split(".")[0]!;
      const statementShaped = rupeeDigits.includes(",") || rupeeDigits.length >= 4;
      if (statementShaped) {
        positives++;
      } else if (mark[1] === "" && mark[3] === "" && /^\d{1,2}$/.test(rupeeDigits)) {
        crore = true;
      } else {
        return null;
      }
    }
  }

  s = s.replace(CURRENCY_PREFIX, "");
  if (s.startsWith("-")) {
    negatives++;
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    positives++;
    s = s.slice(1);
  }
  // "-₹450" as well as "₹-450".
  s = s.trim().replace(CURRENCY_PREFIX, "").replace(/\s+/g, "");

  // A minus alongside any other sign is a contradiction or a double negative.
  if (negatives > 1 || (negatives === 1 && positives > 0)) return null;

  // Lakh / thousand shorthand — typed only. Crore was settled above.
  let multiplier = crore ? 1_00_00_000 : 1;
  if (!crore && context === "typed") {
    const suffix = /^(.*?)(l|k)$/i.exec(s);
    if (suffix) {
      multiplier = suffix[2]!.toLowerCase() === "l" ? 1_00_000 : 1_000;
      s = suffix[1]!;
    }
  }

  const parts = /^([\d,]*)(?:\.(\d*))?$/.exec(s);
  if (!parts) return null;
  const whole = parts[1]!;
  const fraction = parts[2] ?? "";
  if (whole === "" && fraction === "") return null;
  if (!UNGROUPED.test(whole) && !INDIAN_GROUPS.test(whole) && !WESTERN_GROUPS.test(whole)) {
    return null;
  }

  // Exact decimal arithmetic: "1.2345Cr" is 1,23,45,000 rupees exactly, while
  // "1.234" is not a whole number of paise and is refused rather than rounded.
  const digits = BigInt(`${whole.replace(/,/g, "") || "0"}${fraction}`);
  const scaled = digits * BigInt(multiplier * RUPEE);
  const divisor = 10n ** BigInt(fraction.length);
  if (scaled % divisor !== 0n) return null;
  const paise = Number(scaled / divisor);
  if (!Number.isSafeInteger(paise)) return null;
  return negatives === 1 && paise !== 0 ? -paise : paise;
}

/**
 * Evaluate an arithmetic expression in an amount field (F4.10): "450+120*2".
 *
 * Deliberately a hand-written parser rather than anything eval-shaped: this
 * string arrives from a form field. Supports + - * / and parentheses, with the
 * usual precedence. Returns null on anything it does not fully understand.
 */
export function evaluateAmountExpression(input: string): Paise | null {
  const src = input.trim().replace(/[₹,\s]/g, "");
  if (src === "") return null;

  // A plain amount (possibly with a L/Cr/K suffix) is not an expression.
  if (!/[+\-*/()]/.test(src.slice(1))) return parseAmount(input);

  // Nor is a plain amount in brackets: "(1,234.00)" is the accountant's
  // negative, which is what a bank balance copied from a statement looks
  // like. Read as grouping it came out +₹1,234 — the reconcile screen then
  // posted an adjustment of the wrong sign, off by ₹2,468. Brackets that hold
  // an operator ("(450+120)*2") are still grouping.
  if (/^\([^()+\-*/]*\)$/.test(src)) return parseAmount(input);

  let pos = 0;

  function peek(): string | undefined {
    return src[pos];
  }

  function parseExpr(): number | null {
    let left = parseTerm();
    if (left === null) return null;
    for (;;) {
      const op = peek();
      if (op !== "+" && op !== "-") return left;
      pos++;
      const right = parseTerm();
      if (right === null) return null;
      left = op === "+" ? left + right : left - right;
    }
  }

  function parseTerm(): number | null {
    let left = parseFactor();
    if (left === null) return null;
    for (;;) {
      const op = peek();
      if (op !== "*" && op !== "/") return left;
      pos++;
      const right = parseFactor();
      if (right === null) return null;
      if (op === "/" && right === 0) return null;
      left = op === "*" ? left * right : left / right;
    }
  }

  function parseFactor(): number | null {
    const ch = peek();
    // A unary sign is only legal at the start of the expression or just inside
    // a bracket. "450++120" is a typo, not "450 + (+120)" — in an amount field
    // computing a plausible number from a slip is the wrong failure mode.
    const unaryAllowed = pos === 0 || src[pos - 1] === "(";
    if (ch === "-" && unaryAllowed) {
      pos++;
      const v = parseFactor();
      return v === null ? null : -v;
    }
    if (ch === "+" && unaryAllowed) {
      pos++;
      return parseFactor();
    }
    if (ch === "(") {
      pos++;
      const v = parseExpr();
      if (v === null || peek() !== ")") return null;
      pos++;
      return v;
    }
    const start = pos;
    while (pos < src.length && /[\d.]/.test(src[pos]!)) pos++;
    if (pos === start) return null;
    const num = Number(src.slice(start, pos));
    return Number.isFinite(num) ? num : null;
  }

  const result = parseExpr();
  if (result === null || pos !== src.length) return null;

  const paise = Math.round(result * RUPEE);
  return Number.isSafeInteger(paise) ? paise : null;
}
