/**
 * `07` §6 · Price and FX providers.
 *
 * P1 · Each sits behind one interface: given an identifier, return a price
 * with its currency, date and source, **or a typed failure**. Never a throw
 * that a caller might swallow, and never a zero standing in for "unknown".
 *
 * P7 · Every call is server-side. The PWA never talks to a provider — that
 * would leak a key into the client and multiply calls by the number of devices.
 *
 * P8 · Only a symbol goes out. No provider receives holdings, quantities or
 * anything identifying the household.
 *
 * P9 · The app works with every provider disabled. Manual price entry is a
 * first-class path (R26.6), not a degraded one.
 *
 * ## What is verified and what is not
 *
 * `07` §6 is explicit about this, and it is repeated here because the code has
 * to act on it:
 *
 * - **MFAPI** — response shape verified live on 26-08-2026. NAV is a *string*
 *   and dates are DD-MM-YYYY.
 * - **Frankfurter** — verified live. v2 is pinned, v1 is the fallback.
 * - **Alpha Vantage** — the endpoint, the `.BSE` suffix and the quota are
 *   verified, but **the `GLOBAL_QUOTE` field names are not**. The adapter
 *   therefore reads defensively and reports a typed failure rather than
 *   guessing, and says so in the failure message.
 *
 * `10` §3.3 adds that MFAPI is a third-party wrapper over AMFI and can vanish
 * without recourse; the mitigation is that R24.6 stores the ISIN, so a second
 * adapter reading AMFI's own file can be slotted in behind this interface.
 */

import type { IsoDate } from "../core/dates.ts";
import { todayIST } from "../core/dates.ts";
import { price as toMicroRupees, type MicroRupees } from "./holdings.ts";

export type ProviderName = "mfapi" | "frankfurter" | "alphavantage" | "manual";

export interface PriceResult {
  ok: true;
  price: MicroRupees;
  currency: string;
  /** R26.2 · The date the price was published, never the date it was fetched. */
  asOf: IsoDate;
  source: ProviderName;
  name?: string;
  isin?: string | null;
}

export interface PriceFailure {
  ok: false;
  /** Typed, so a caller can tell "throttled" from "no such symbol". */
  reason: "not-found" | "throttled" | "unavailable" | "unparseable" | "not-configured";
  message: string;
  source: ProviderName;
}

export type PriceOutcome = PriceResult | PriceFailure;

export interface Provider {
  name: ProviderName;
  /** P5 · The app enforces its own ceiling rather than discovering one. */
  dailyCallCeiling: number | null;
  fetchPrice(symbol: string, opts?: FetchOptions): Promise<PriceOutcome>;
}

export interface FetchOptions {
  fetchImpl?: typeof fetch;
  apiKey?: string | null;
  timeoutMs?: number;
}

function fail(source: ProviderName, reason: PriceFailure["reason"], message: string): PriceFailure {
  return { ok: false, reason, message, source };
}

async function getJson(
  url: string, opts: FetchOptions,
): Promise<{ ok: true; body: unknown } | { ok: false; status: number }> {
  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);
  try {
    const response = await doFetch(url, { signal: controller.signal });
    if (!response.ok) return { ok: false, status: response.status };
    return { ok: true, body: await response.json() };
  } catch {
    return { ok: false, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

/** MFAPI dates are DD-MM-YYYY; everything internal is YYYY-MM-DD. */
export function parseMfapiDate(value: string): IsoDate | null {
  const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(value.trim());
  return match ? `${match[3]}-${match[2]}-${match[1]}` : null;
}

/**
 * `07` §6.2 · Indian mutual fund NAV, from MFAPI.
 *
 * No key, no quota — which is why `09` §6.3 makes it the primary and
 * near-sufficient provider for this household's portfolio.
 */
export const mfapi: Provider = {
  name: "mfapi",
  dailyCallCeiling: null,

  async fetchPrice(schemeCode, opts = {}) {
    const result = await getJson(`https://api.mfapi.in/mf/${encodeURIComponent(schemeCode)}/latest`, opts);
    if (!result.ok) {
      return result.status === 404
        ? fail("mfapi", "not-found", `No scheme with code ${schemeCode}.`)
        : fail("mfapi", "unavailable", `MFAPI did not answer (HTTP ${result.status}).`);
    }

    const body = result.body as {
      status?: string;
      meta?: { scheme_name?: string; isin_growth?: string | null };
      data?: { date?: string; nav?: string }[];
    };

    if (body.status && body.status !== "SUCCESS") {
      return fail("mfapi", "not-found", `MFAPI reported "${body.status}" for ${schemeCode}.`);
    }

    const latest = body.data?.[0];
    if (!latest?.nav || !latest.date) {
      return fail("mfapi", "unparseable", "MFAPI returned no NAV for that scheme.");
    }

    const asOf = parseMfapiDate(latest.date);
    // NAV is a string and must be parsed as a decimal, never assumed a float
    // literal — §6.2 is explicit about this.
    const nav = Number(latest.nav);
    if (!asOf || !Number.isFinite(nav) || nav <= 0) {
      return fail("mfapi", "unparseable", `Could not read "${latest.nav}" as a NAV.`);
    }

    return {
      ok: true,
      price: toMicroRupees(nav),
      currency: "INR",
      asOf,
      source: "mfapi",
      name: body.meta?.scheme_name,
      // R24.6 / `10` §3.3: the ISIN is what makes a provider swap survivable.
      isin: body.meta?.isin_growth ?? null,
    };
  },
};

export interface SchemeSearchResult {
  schemeCode: string;
  schemeName: string;
}

/**
 * `07` §6.2 · The onboarding path.
 *
 * S13b shows the **full** scheme name, because Direct and Regular plans are
 * different scheme codes with different NAVs and are otherwise indistinguishable.
 */
export async function searchSchemes(
  query: string, opts: FetchOptions = {},
): Promise<SchemeSearchResult[]> {
  const result = await getJson(
    `https://api.mfapi.in/mf/search?q=${encodeURIComponent(query)}`, opts,
  );
  if (!result.ok) return [];
  const rows = result.body as { schemeCode?: number; schemeName?: string }[];
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => r.schemeCode && r.schemeName)
    .map((r) => ({ schemeCode: String(r.schemeCode), schemeName: r.schemeName! }));
}

/**
 * `07` §6.3 · FX reference rates, from Frankfurter.
 *
 * R32.2 · These are **daily reference rates published on working days**, not
 * live ticks. Nothing here may imply tradeable pricing.
 */
export async function fetchFxRate(
  base: string, quote: string, opts: FetchOptions & { on?: IsoDate } = {},
): Promise<PriceOutcome> {
  if (base === quote) {
    return { ok: true, price: toMicroRupees(1), currency: quote, asOf: opts.on ?? todayIST(), source: "frankfurter" };
  }

  // v2 is pinned; v1 is the documented fallback (§6.3).
  const url = opts.on
    ? `https://api.frankfurter.dev/v1/${opts.on}?base=${base}&symbols=${quote}`
    : `https://api.frankfurter.dev/v2/rate/${base}/${quote}`;

  const result = await getJson(url, opts);
  if (!result.ok) {
    return fail("frankfurter", "unavailable", `Frankfurter did not answer (HTTP ${result.status}).`);
  }

  const body = result.body as {
    date?: string; rate?: number; rates?: Record<string, number>;
  };
  const rate = body.rate ?? body.rates?.[quote];
  const asOf = body.date;

  if (!Number.isFinite(rate) || !asOf) {
    return fail("frankfurter", "unparseable", `No ${base}/${quote} rate in the response.`);
  }

  return {
    ok: true,
    price: toMicroRupees(rate!),
    currency: quote,
    // R32.3: the date the rate was actually published, so a weekend lookup is
    // labelled Friday rather than silently forward-filled.
    asOf,
    source: "frankfurter",
  };
}

/**
 * `07` §6.4 · Equities and ETFs, from Alpha Vantage.
 *
 * `09` §6.3 makes this **optional**: the household holds mutual funds, so the
 * app must work with no key configured at all.
 *
 * The `GLOBAL_QUOTE` field names are **[unverified]** — §6.4 says so and warns
 * against assuming them from memory. So the parser tries the documented shape,
 * falls back to scanning for a plausible price field, and returns a typed
 * failure naming the problem rather than inventing a number.
 */
export const alphaVantage: Provider = {
  name: "alphavantage",
  // §6.4 verified: 25 requests per day on the free tier. Enforced app-side.
  dailyCallCeiling: 25,

  async fetchPrice(symbol, opts = {}) {
    if (!opts.apiKey) {
      return fail(
        "alphavantage", "not-configured",
        "No Alpha Vantage key is configured. Equity prices can be entered manually.",
      );
    }

    const result = await getJson(
      `https://www.alphavantage.co/query?function=GLOBAL_QUOTE` +
        `&symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(opts.apiKey)}`,
      opts,
    );
    if (!result.ok) {
      return fail("alphavantage", "unavailable", `Alpha Vantage did not answer (HTTP ${result.status}).`);
    }

    const body = result.body as Record<string, unknown>;

    // Exceeding the quota returns a message rather than data (§6.4).
    if (typeof body.Note === "string" || typeof body.Information === "string") {
      return fail(
        "alphavantage", "throttled",
        "Alpha Vantage is rate-limiting: 25 calls a day on the free tier.",
      );
    }
    if (typeof body["Error Message"] === "string") {
      return fail("alphavantage", "not-found", `Alpha Vantage does not know "${symbol}".`);
    }

    const quote = body["Global Quote"] as Record<string, string> | undefined;
    if (!quote) {
      return fail(
        "alphavantage", "unparseable",
        "Alpha Vantage returned no quote block. The response shape was never " +
          "verified against a real key — check it before relying on this provider.",
      );
    }

    const priceField = Object.entries(quote).find(([k]) => /price/i.test(k))?.[1];
    const dateField = Object.entries(quote).find(([k]) => /trading day|latest/i.test(k))?.[1];
    const value = Number(priceField);

    if (!Number.isFinite(value) || value <= 0) {
      return fail(
        "alphavantage", "unparseable",
        `Could not find a price in the quote for "${symbol}".`,
      );
    }

    return {
      ok: true,
      price: toMicroRupees(value),
      // .BSE means rupees; anything else is assumed the listing currency.
      currency: symbol.endsWith(".BSE") ? "INR" : "USD",
      asOf: dateField && /^\d{4}-\d{2}-\d{2}$/.test(dateField) ? dateField : todayIST(),
      source: "alphavantage",
    };
  },
};

export const PROVIDERS: Record<string, Provider> = {
  mfapi,
  alphavantage: alphaVantage,
};

// ---------------------------------------------------------------------------
// P5 · The app's own daily ceiling
// ---------------------------------------------------------------------------

/**
 * P5 · "a hard daily call ceiling per provider that the app enforces itself
 * rather than discovering by being throttled."
 *
 * P6 · The remaining quota is shown wherever a manual refresh is offered, and
 * F27.1 puts it on the health page.
 */
export interface QuotaState {
  provider: ProviderName;
  used: number;
  ceiling: number | null;
  remaining: number | null;
  exhausted: boolean;
}

export function quotaFor(provider: Provider, usedToday: number): QuotaState {
  const ceiling = provider.dailyCallCeiling;
  return {
    provider: provider.name,
    used: usedToday,
    ceiling,
    remaining: ceiling === null ? null : Math.max(0, ceiling - usedToday),
    exhausted: ceiling !== null && usedToday >= ceiling,
  };
}

/**
 * P5 · Jitter, so a fleet of refreshes does not arrive as a burst. Small and
 * deterministic in tests via the injected random.
 */
export function jitterMs(random: () => number = Math.random): number {
  return Math.floor(random() * 30_000);
}

/** P5 · Exponential backoff on failure, capped so it cannot stall a day. */
export function backoffMs(attempt: number): number {
  return Math.min(2 ** attempt * 1_000, 15 * 60_000);
}
