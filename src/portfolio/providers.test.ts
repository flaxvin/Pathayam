/**
 * Provider adapters against the responses `07` §6 verified live on
 * 26-08-2026, and against the failures each one actually produces.
 *
 * No test here touches the network — every one injects a fetch. P7 says all
 * calls are server-side; that does not mean a test suite should make them.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  mfapi, alphaVantage, fetchFxRate, searchSchemes, parseMfapiDate,
  quotaFor, backoffMs, jitterMs, type PriceOutcome,
} from "./providers.ts";
import { price } from "./holdings.ts";

function jsonFetch(body: unknown, status = 200): typeof fetch {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

function failingFetch(status = 500): typeof fetch {
  return (async () => ({ ok: false, status, json: async () => ({}) })) as unknown as typeof fetch;
}

function throwingFetch(): typeof fetch {
  return (async () => {
    throw new Error("network unreachable");
  }) as unknown as typeof fetch;
}

/** The exact response `07` §6.2 recorded from `/mf/119551/latest`. */
const MFAPI_VERIFIED = {
  meta: {
    fund_house: "Aditya Birla Sun Life Mutual Fund",
    scheme_code: 119551,
    scheme_name: "Aditya Birla Sun Life Banking & PSU Debt Fund - Direct Plan - IDCW-Re-investment",
    isin_growth: "INF209KA12Z1",
  },
  data: [{ date: "25-08-2026", nav: "106.94190" }],
  status: "SUCCESS",
};

describe("MFAPI — 07 §6.2", () => {
  test("reads the verified response, NAV as a decimal string", () => {
    return mfapi.fetchPrice("119551", { fetchImpl: jsonFetch(MFAPI_VERIFIED) }).then((result) => {
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.price, price(106.9419), "five decimals survive");
      assert.equal(result.currency, "INR");
      // DD-MM-YYYY in, YYYY-MM-DD internally.
      assert.equal(result.asOf, "2026-08-25");
      assert.equal(result.isin, "INF209KA12Z1", "R24.6 — survives a provider swap");
      assert.match(result.name!, /Direct Plan/);
    });
  });

  test("consumes no quota — which is why it is the primary provider", () => {
    assert.equal(mfapi.dailyCallCeiling, null);
  });

  test("reports a typed failure rather than throwing", async () => {
    const missing = await mfapi.fetchPrice("999999", { fetchImpl: failingFetch(404) });
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.reason, "not-found");

    const down = await mfapi.fetchPrice("119551", { fetchImpl: failingFetch(503) });
    assert.equal(down.ok, false);
    if (!down.ok) assert.equal(down.reason, "unavailable");

    const offline = await mfapi.fetchPrice("119551", { fetchImpl: throwingFetch() });
    assert.equal(offline.ok, false, "a thrown network error is caught, not propagated");
  });

  test("refuses to invent a number from an unreadable NAV", async () => {
    const result = await mfapi.fetchPrice("119551", {
      fetchImpl: jsonFetch({ ...MFAPI_VERIFIED, data: [{ date: "25-08-2026", nav: "n/a" }] }),
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "unparseable");
  });

  test("honours a non-SUCCESS status", async () => {
    const result = await mfapi.fetchPrice("1", { fetchImpl: jsonFetch({ status: "FAILED" }) });
    assert.equal(result.ok, false);
  });

  test("parses DD-MM-YYYY and rejects anything else", () => {
    assert.equal(parseMfapiDate("25-08-2026"), "2026-08-25");
    assert.equal(parseMfapiDate("2026-08-25"), null);
    assert.equal(parseMfapiDate("nonsense"), null);
  });

  test("search returns both plans, so Direct and Regular are distinguishable", async () => {
    // The verified response from §6.2.
    const results = await searchSchemes("parag parikh flexi cap", {
      fetchImpl: jsonFetch([
        { schemeCode: 122640, schemeName: "Parag Parikh Flexi Cap Fund - Regular Plan - Growth" },
        { schemeCode: 122639, schemeName: "Parag Parikh Flexi Cap Fund - Direct Plan - Growth" },
      ]),
    });

    assert.equal(results.length, 2);
    assert.equal(results[1]!.schemeCode, "122639");
    // The full name is what stops Direct being confused with Regular (L15).
    assert.match(results[0]!.schemeName, /Regular Plan/);
    assert.match(results[1]!.schemeName, /Direct Plan/);
  });

  test("search returns nothing rather than failing when the API is down", async () => {
    assert.deepEqual(await searchSchemes("x", { fetchImpl: failingFetch() }), []);
  });
});

describe("Frankfurter — 07 §6.3", () => {
  test("reads the verified v2 response", async () => {
    const result = await fetchFxRate("USD", "INR", {
      fetchImpl: jsonFetch({ date: "2026-08-26", base: "USD", quote: "INR", rate: 95.51 }),
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.price, price(95.51));
    assert.equal(result.asOf, "2026-08-26");
  });

  test("reads the verified v1 historical response", async () => {
    const result = await fetchFxRate("USD", "INR", {
      on: "2026-08-25",
      fetchImpl: jsonFetch({
        amount: 1.0, base: "USD", date: "2026-08-25",
        rates: { EUR: 0.85749, GBP: 0.73358, INR: 95.42, SGD: 1.2703 },
      }),
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.price, price(95.42));
  });

  test("R32.3 — reports the date the rate was actually published", async () => {
    // Asking for a Sunday; the ECB published on Friday.
    const result = await fetchFxRate("USD", "INR", {
      on: "2026-08-23",
      fetchImpl: jsonFetch({ base: "USD", date: "2026-08-21", rates: { INR: 95.42 } }),
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.asOf, "2026-08-21", "never the date asked for");
  });

  test("needs no call at all to convert a currency to itself", async () => {
    const result = await fetchFxRate("INR", "INR", { fetchImpl: throwingFetch() });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.price, price(1));
  });

  test("reports a typed failure when the response has no rate", async () => {
    const result = await fetchFxRate("USD", "XYZ", {
      fetchImpl: jsonFetch({ base: "USD", date: "2026-08-26", rates: {} }),
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "unparseable");
  });
});

describe("Alpha Vantage — 07 §6.4, optional by Q16", () => {
  test("says so plainly when no key is configured, rather than failing oddly", async () => {
    const result = await alphaVantage.fetchPrice("RELIANCE.BSE", {});
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "not-configured");
      // P9: manual entry is a first-class path, and the message says so.
      assert.match(result.message, /entered manually/);
    }
  });

  test("reads a GLOBAL_QUOTE defensively, because the shape is unverified", async () => {
    const result = await alphaVantage.fetchPrice("RELIANCE.BSE", {
      apiKey: "key",
      fetchImpl: jsonFetch({
        "Global Quote": {
          "01. symbol": "RELIANCE.BSE",
          "05. price": "1423.5500",
          "07. latest trading day": "2026-08-25",
        },
      }),
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.price, price(1423.55));
    assert.equal(result.currency, "INR", ".BSE means rupees");
    assert.equal(result.asOf, "2026-08-25");
  });

  test("treats a symbol without .BSE as a foreign listing", async () => {
    const result = await alphaVantage.fetchPrice("AAPL", {
      apiKey: "key",
      fetchImpl: jsonFetch({ "Global Quote": { "05. price": "180.00" } }),
    });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.currency, "USD");
  });

  test("recognises the quota message rather than reading it as data", async () => {
    // §6.4: exceeding the limit returns a message, not an error status.
    const result = await alphaVantage.fetchPrice("AAPL", {
      apiKey: "key",
      fetchImpl: jsonFetch({ Note: "Thank you for using Alpha Vantage! Our standard API..." }),
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "throttled");
      assert.match(result.message, /25 calls a day/);
    }
  });

  test("refuses to guess when the quote block is missing", async () => {
    const result = await alphaVantage.fetchPrice("AAPL", {
      apiKey: "key", fetchImpl: jsonFetch({ something: "else" }),
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "unparseable");
      // The message tells the reader the shape was never verified.
      assert.match(result.message, /never verified/);
    }
  });

  test("carries the verified 25-a-day ceiling", () => {
    assert.equal(alphaVantage.dailyCallCeiling, 25);
  });
});

describe("P5, P6 · the app enforces its own ceiling", () => {
  test("reports the remaining quota rather than discovering the limit", () => {
    const fresh = quotaFor(alphaVantage, 0);
    assert.equal(fresh.remaining, 25);
    assert.equal(fresh.exhausted, false);

    const spent = quotaFor(alphaVantage, 25);
    assert.equal(spent.remaining, 0);
    assert.equal(spent.exhausted, true);
  });

  test("an unlimited provider has no ceiling to report", () => {
    const quota = quotaFor(mfapi, 4_000);
    assert.equal(quota.remaining, null);
    assert.equal(quota.exhausted, false);
  });

  test("backoff grows and then caps, so it cannot stall a whole day", () => {
    assert.equal(backoffMs(0), 1_000);
    assert.equal(backoffMs(3), 8_000);
    assert.equal(backoffMs(30), 15 * 60_000);
  });

  test("jitter stays inside its window", () => {
    assert.equal(jitterMs(() => 0), 0);
    assert.ok(jitterMs(() => 0.999) < 30_000);
  });
});

describe("P8 · nothing identifying the household goes out", () => {
  test("only a symbol appears in the request", async () => {
    const urls: string[] = [];
    const spy = (async (url: unknown) => {
      urls.push(String(url));
      return { ok: true, status: 200, json: async () => MFAPI_VERIFIED };
    }) as unknown as typeof fetch;

    await mfapi.fetchPrice("119551", { fetchImpl: spy });
    await fetchFxRate("USD", "INR", { fetchImpl: spy });

    for (const url of urls) {
      assert.ok(!/units|holding|amount|account|member/i.test(url), url);
    }
    assert.match(urls[0]!, /api\.mfapi\.in\/mf\/119551\/latest$/);
  });
});

describe("the provider interface is uniform", () => {
  test("every provider returns the same shape on success and failure", async () => {
    const outcomes: PriceOutcome[] = [
      await mfapi.fetchPrice("119551", { fetchImpl: jsonFetch(MFAPI_VERIFIED) }),
      await alphaVantage.fetchPrice("AAPL", {
        apiKey: "k", fetchImpl: jsonFetch({ "Global Quote": { "05. price": "1.00" } }),
      }),
      await mfapi.fetchPrice("x", { fetchImpl: failingFetch(404) }),
      await alphaVantage.fetchPrice("x", {}),
    ];

    for (const outcome of outcomes) {
      if (outcome.ok) {
        assert.ok(outcome.price > 0 && outcome.currency && outcome.asOf && outcome.source);
      } else {
        assert.ok(outcome.reason && outcome.message && outcome.source);
      }
    }
  });
});
