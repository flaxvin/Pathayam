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
  const negative = amount < 0;
  const abs = Math.abs(amount);
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
  const abs = Math.abs(amount);
  const whole = Math.trunc(abs / RUPEE);
  const paise = abs - whole * RUPEE;
  const parts: string[] = [];
  parts.push(`${whole} ${whole === 1 ? "rupee" : "rupees"}`);
  if (paise !== 0) parts.push(`${paise} paise`);
  return `${negative ? "minus " : ""}${parts.join(" ")}`;
}

// ---------------------------------------------------------------------------
// Parsing — accepts what an Indian keyboard actually produces
// ---------------------------------------------------------------------------

/**
 * Parse a typed amount into paise. Returns null on anything unparseable —
 * callers decide what to tell the user; this never throws on user input.
 *
 * Accepts: "1234", "1,234", "12,34,567.89", "₹450", "450.5", "1.2L", "3Cr",
 * "1200 Dr", "(450)" (accounting negative), and the "Cr"/"Dr" suffixes that
 * Indian statements use (`04` §3.2).
 */
export function parseAmount(input: string): Paise | null {
  let s = input.trim();
  if (s === "") return null;

  let sign = 1;

  // Accounting-style parentheses: (450) is -450
  if (/^\(.*\)$/.test(s)) {
    sign = -1;
    s = s.slice(1, -1).trim();
  }

  // Cr / Dr suffix as used on Indian bank statements
  const crDr = /\b(cr|dr)\.?\s*$/i.exec(s);
  if (crDr) {
    if (crDr[1]!.toLowerCase() === "dr") sign = -sign;
    s = s.slice(0, crDr.index).trim();
  }

  s = s.replace(/[₹\s]/g, "").replace(/,/g, "");

  if (s.startsWith("-")) {
    sign = -sign;
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }

  // Lakh / crore / thousand suffix
  let multiplier = 1;
  const suffix = /^(.*?)(cr|l|k)$/i.exec(s);
  if (suffix) {
    const unit = suffix[2]!.toLowerCase();
    multiplier = unit === "cr" ? 1_00_00_000 : unit === "l" ? 1_00_000 : 1_000;
    s = suffix[1]!;
  }

  if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") return null;

  const value = Number(s);
  if (!Number.isFinite(value)) return null;

  const paise = Math.round(value * multiplier * RUPEE);
  if (!Number.isSafeInteger(paise)) return null;
  return sign * paise;
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
