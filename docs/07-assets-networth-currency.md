# 07 · Assets, Net Worth & Multi-Currency

**Draft v0.1 · 26-08-2026 · Functional scope only.**
Extends `02-functional-design.md`. Engine rules continue at **R23**; modules are **F19** and **F20**.

---

## 1. The call

**Track assets and net worth in a walled garden beside the budget, with holdings held as units and revalued from a hardcoded price feed — and never let a rupee of market value touch Ready to Assign.**

Three supports:

1. **Units, not values, are the unit of record.** You own 936.043 units of a fund, not "about ₹80,000". Every figure that matters — cost basis, unrealised gain, realised gain on a partial sale, XIRR — falls out of units and dated prices. An app storing a rupee balance you retype monthly can compute none of them.
2. **The firewall is the whole design.** `05` §5 excluded net worth on the grounds that every budgeting app which added it became a dashboard. That exclusion is now reversed at your instruction, and the containment is R30: investments live in Tracking accounts, market movement never becomes income, and the budget screen never displays portfolio value. Break R30 and the earlier objection comes true.
3. **Foreign holdings have two returns, and only one of them is yours.** On the worked example — 10 shares bought at $150 when USD/INR was 83.00, now $180 at 95.51 — the ₹47,418 gain is 53% investment and **47% exchange rate**. Reporting a single number hides which bet actually paid.

---

## 2. Scope decisions

| Decision | Choice | Consequence |
|---|---|---|
| Net worth tracking | **In scope** — reverses the exclusion in `05` §5 | Contained by R30; see §12 Q15 for the standing test |
| Holdings | **Unit-based**, with dated prices and FIFO lots | Enables cost basis, realised/unrealised split, XIRR |
| Price refresh | **Automatic**, from hardcoded providers per asset class (§6) | Manual entry always remains available and is never a degraded path |
| Multi-currency | **In scope**, base currency ₹, per-account currency | FX gain reported separately from asset gain (R34) |
| FX rates | **Automatic**, hardcoded provider (§6.3) | Transaction rates frozen at trade date; holdings revalued daily |
| Tax | **Out of scope** | The app reports gains and holding periods. It computes no tax and gives no advice. |

---

## 3. Glossary additions

Extends `02` §3 and `06` §3.

| Concept | Definition |
|---|---|
| **Asset account** | A Tracking account holding something of value: an investment account, a physical asset, a retirement balance, a deposit. Never funds the budget. |
| **Instrument** | A tradeable thing with a price: a mutual fund scheme, an equity share, an ETF, a bond. Identified by a provider-specific symbol plus, where available, an ISIN. |
| **Holding** | A position in one instrument inside one asset account: a set of lots. |
| **Lot** | One purchase — trade date, units, price per unit, and the fees paid. The atom of cost-basis accounting. |
| **Units** | Quantity held. Mutual funds carry three decimals; equities are usually whole. |
| **Cost basis** | Total paid for the units held, including capitalised charges. |
| **Average cost** | Cost basis ÷ units. A display figure, never the basis for a realised-gain computation (R27). |
| **Market value** | Units × latest price × FX rate to base currency. |
| **Unrealised gain** | Market value − cost basis. Never income (R30). |
| **Realised gain** | Proceeds − cost of the specific units sold, computed FIFO. |
| **Price quote** | A dated price for an instrument, with its source and the time it was fetched. |
| **Stale price** | A quote older than the instrument's expected refresh interval. Always labelled, never hidden. |
| **Base currency** | The household's reporting currency. ₹ for this deployment. Every envelope, target and report is in base currency. |
| **Account currency** | The currency an account actually holds. May differ from base. |
| **FX rate** | A dated base-per-unit-of-foreign-currency rate, with its source. |
| **Frozen rate** | The FX rate recorded on a transaction at trade date. Never retrospectively changed (R33). |
| **Asset gain** | The part of a foreign holding's base-currency gain caused by the instrument's price moving. |
| **FX gain** | The part caused by the exchange rate moving. |
| **Net worth** | Total assets − total liabilities, at a point in time, in base currency. |

---

## 4. Engine rules — assets and net worth

Continues `02` §4 and `06` §4. All figures verified by computation (§10).

---

### R23 — Asset accounts

Asset accounts are Tracking accounts (`02` F2.4). They never fund the budget and never appear in Ready to Assign.

**Kinds the app MUST support:**

| Kind | Valued by | Example |
|---|---|---|
| **Investment account** | Sum of its holdings at market value | Demat account, mutual fund folio, US brokerage |
| **Retirement balance** | Manually entered balance with a dated history | EPF, PPF, NPS |
| **Deposit** | Principal plus accrued interest, or a manual balance | FD, RD |
| **Physical asset** | Manually entered valuation with a dated history | Property, vehicle, jewellery |
| **Commodity holding** | Units × price | Physical gold in grams, SGB units |
| **Receivable** | Manual balance | Money lent, deposits with a landlord |

**Rules:**

- R23.1 Every asset account MUST carry a currency and MUST report in base currency (R31).
- R23.2 A manually valued asset MUST store a **dated history of valuations**, not a single mutable number. Net worth over time is meaningless otherwise.
- R23.3 A manually valued asset MUST show its valuation date and MUST be flagged stale after a configurable interval (default 180 days).
- R23.4 Where a liability exists against an asset — a home loan against a property, a car loan against a vehicle — the app MUST prompt to create the asset when the loan is created (`06` R14). A tracked liability without its underlying asset makes net worth systematically wrong and alarming.
- R23.5 Asset accounts MUST be closeable without deletion, retaining history.

---

### R24 — Holdings as units

- R24.1 A holding MUST be recorded as **units of an instrument**, never as a rupee balance.
- R24.2 A purchase MUST record: trade date, units OR amount, price per unit, fees and charges, and the account paid from.
- R24.3 Where the user enters an **amount and a price**, units MUST be derived — this is how SIPs work, and the derived units MUST be stored to three decimals.
- R24.4 Where the user enters **units and a price**, the amount MUST be derived.
- R24.5 Fees and charges (brokerage, STT, stamp duty, GST, exit load) MUST be recorded and MUST be capitalised into cost basis by default, with the option to expense them instead.
- R24.6 An instrument MUST be identifiable by provider symbol and, where available, ISIN, so a change of price provider does not orphan the holding.
- R24.7 The app MUST support a holding whose instrument has no price feed at all, valued by manual price entry.

**Worked example — three SIP instalments into one fund:**

| Date | Amount | NAV | Units |
|---|---|---|---|
| 05-01-2026 | ₹25,000 | 80.00 | 312.500 |
| 05-02-2026 | ₹25,000 | 82.50 | 303.030 |
| 05-03-2026 | ₹25,000 | 78.00 | 320.513 |
| **Total** | **₹75,000** | avg cost **80.12** | **936.043** |

At NAV 86.40 on 26-08-2026: market value **₹80,874.13**, unrealised gain **₹5,874.13**, absolute return **7.83%**, **XIRR 14.51%**.

The gap between 7.83% and 14.51% is the entire argument for storing units and dates: absolute return treats March's money as though it had been invested since January.

---

### R25 — Cost basis and lots

- R25.1 Every purchase MUST create a **lot**. Lots are never merged.
- R25.2 Realised gains MUST be computed **FIFO** — oldest lots first. This matches how Indian capital gains are ordinarily computed for units, and it is the only method that also gives a correct holding period per unit sold. [inferred — confirm against your own tax position; the app computes no tax.]
- R25.3 Average cost MUST be shown for readability but MUST NOT be used to compute a realised gain.
- R25.4 A partial sale MUST split the affected lot, retaining the residual at its original price and date.
- R25.5 Each lot MUST expose its **holding period**, so long-term versus short-term classification is visible to the user, who draws their own conclusions.

**Worked example — selling 400 units at NAV 86.40:**

FIFO takes 312.500 units at 80.00 (₹25,000.00) and 87.500 units at 82.50 (₹7,218.75).

| | |
|---|---|
| Proceeds | ₹34,560.00 |
| Cost of units sold | ₹32,218.75 |
| **Realised gain** | **₹2,341.25** |
| Units remaining | 536.043 |

---

### R26 — Valuation and price refresh

- R26.1 Market value = units × latest price × FX rate to base currency (R31).
- R26.2 Every displayed value MUST carry its **price date**. A portfolio value with no as-of date is not a number, it is a rumour.
- R26.3 Prices MUST be cached and MUST be refreshed on a schedule per asset class (§6.4), not on every screen load.
- R26.4 A stale price MUST be visibly marked and the value MUST still be shown — never blanked, never zeroed.
- R26.5 A failed refresh MUST NOT overwrite a good cached price, MUST be logged, and MUST surface in Review after N consecutive failures (default 3).
- R26.6 Manual price override MUST always be available and MUST persist until the next successful automatic refresh, or permanently if the instrument is marked manual-only.
- R26.7 The app MUST store a **price history** per instrument, so portfolio value over time is real history rather than today's price applied backwards.
- R26.8 A price MUST never be interpolated or forward-filled silently. Where a market was closed, the last published price is used and labelled with its actual date.

---

### R27 — Gains and returns

**Definitions, stated exactly, because these get quoted.**

| Metric | Definition |
|---|---|
| **Unrealised gain** | Market value − cost basis of units still held |
| **Realised gain** | Σ (proceeds − FIFO cost) over all sales, in the period |
| **Absolute return** | Unrealised gain ÷ cost basis. Ignores time. Misleading for anything bought in instalments. |
| **XIRR** | Money-weighted annualised return over all dated cash flows, with current market value as the terminal inflow. **The default headline return figure.** |
| **CAGR** | Only shown for a single-lot holding, where it is meaningful |
| **Asset gain** | (P₁ − P₀) × units × FX₀ — the price move, valued at the original rate |
| **FX gain** | (FX₁ − FX₀) × units × P₁ — the rate move, valued at the new price |

- R27.1 XIRR MUST be the default return figure for any holding with more than one lot.
- R27.2 Absolute return MAY be shown alongside XIRR but MUST NOT be shown alone where they differ by more than 2 percentage points.
- R27.3 Asset gain and FX gain MUST sum **exactly** to the total base-currency gain. The decomposition above has this property; it is verified in §10 with a zero residual check.
- R27.4 Realised and unrealised gains MUST never be summed into one "gain" figure without labelling both parts.
- R27.5 Dividends and IDCW payouts MUST be tracked separately from price gains and MUST NOT be folded into cost basis.

---

### R28 — Corporate actions and flows

The app MUST support, each as a dated event that adjusts units or cost without being a purchase:

| Event | Effect |
|---|---|
| **Stock split / bonus** | Units multiply by the ratio; total cost basis unchanged; per-unit cost divides |
| **Dividend / IDCW payout** | Cash into a Budget account → income to Ready to Assign (R30). Units unchanged. |
| **Dividend reinvestment / IDCW re-investment** | New lot at the reinvestment NAV. No budget effect. |
| **SIP instalment** | A scheduled purchase (`02` F7) creating a lot and a transfer |
| **SWP withdrawal** | A scheduled partial sale; proceeds are income to Ready to Assign |
| **Switch between schemes** | A sale of one instrument and a purchase of another on the same date, with the realised gain recorded |
| **Merger / scheme consolidation** | Units of A become units of B at a ratio, carrying original cost and dates forward |
| **Rights issue** | A new lot at the rights price |
| **Return of capital** | Reduces cost basis rather than creating a gain |

- R28.1 Every corporate action MUST be reversible and MUST record who applied it and when.
- R28.2 A split or bonus MUST retroactively adjust the price history so charts do not show a false crash.

---

### R29 — The net worth statement

```
Net worth = Σ Budget account balances
          + Σ Asset account values (holdings at market + manual valuations)
          − Σ Credit account balances
          − Σ Loan outstanding principal
```

- R29.1 Net worth MUST be computed in base currency and MUST state its as-of date and the staleness of its worst input.
- R29.2 The app MUST store a **dated net worth history**, snapshotted at least monthly, so the trend is real rather than reconstructed.
- R29.3 The statement MUST break down into asset classes and liability types, each expandable to accounts.
- R29.4 The app MUST show the **change since last period** decomposed into: money saved (net cash added), market movement, FX movement, and debt repaid. A net worth that rose because the rupee weakened is not the same achievement as one that rose because you repaid principal.
- R29.5 Net worth MUST NOT appear on the budget screen, in any form (R30).

**Worked example — 26-08-2026:**

| | ₹ |
|---|---|
| Budget accounts (cash) | 3,42,000.00 |
| Mutual funds | 80,874.13 |
| Foreign equity | 1,71,918.00 |
| EPF and PPF | 14,50,000.00 |
| Gold | 2,85,000.00 |
| Property (self-occupied, at cost) | 62,00,000.00 |
| **Total assets** | **85,29,792.13** |
| Home loan outstanding | 47,92,181.00 |
| Credit cards | 68,400.00 |
| **Total liabilities** | **48,60,581.00** |
| **Net worth** | **36,69,211.13** |

Note what R23.4 buys: omit the property and this household appears to be ₹25.3 lakh underwater. Tracking a loan without its asset is worse than tracking neither.

---

### R30 — The firewall

This rule is why the module is safe to build. It is not negotiable.

| # | Invariant |
|---|---|
| FW1 | An asset account's value NEVER contributes to Ready to Assign. |
| FW2 | Unrealised gains are NEVER income, NEVER a category balance, NEVER assignable. A portfolio doubling changes no envelope. |
| FW3 | Market value and net worth NEVER appear on the budget screen (S1). They live on their own screens. |
| FW4 | Buying an investment is money **leaving the budget**: a transfer from a Budget account to an Asset account, which MUST consume a category tagged as *savings/investment*, so envelope arithmetic stays whole and reports do not count it as consumption. |
| FW5 | Sale proceeds landing in a Budget account ARE income to Ready to Assign — the full proceeds, not the gain. Cash is cash. |
| FW6 | Dividends credited to a Budget account are income. Reinvested dividends are not. |
| FW7 | A price refresh NEVER creates, modifies or deletes a transaction. |
| FW8 | An FX rate change NEVER alters a recorded transaction's base amount (R33). |
| FW9 | Portfolio and net worth screens MUST be fully usable when every price feed is down, using cached values with staleness shown. |
| FW10 | Nothing in this module may make the budget screen slower to open, or block on a network call. |

---

## 5. Engine rules — multi-currency

---

### R31 — Base currency and account currency

- R31.1 The household sets one **base currency** at setup (₹). It MUST NOT be changeable after transactions exist without an explicit, warned migration.
- R31.2 Every account, holding and transaction carries a currency.
- R31.3 **Every envelope, target, assignment and Ready to Assign figure is in base currency, always.** There are no foreign-currency envelopes.
- R31.4 A foreign-currency account defaults to a **Tracking account**, not a Budget account. This keeps Ready to Assign from fluctuating with the exchange rate.
- R31.5 A foreign-currency account MAY be made a Budget account where the household genuinely spends from it. Its base-currency value is then revalued **once per day at a fixed time**, and the delta MUST appear as an explicit *FX revaluation* line — visible, dated, and never silent.
- R31.6 Reports MUST allow viewing in base currency (default) or in an account's own currency, and MUST label which.

---

### R32 — Rate sourcing and staleness

- R32.1 Rates MUST be fetched automatically from the hardcoded provider (§6.3), cached, and stored with their publication date.
- R32.2 The published rate is a **daily reference rate**, not a live tick. The app MUST present it as such and MUST NOT imply tradeable pricing.
- R32.3 Where the source has no rate for a date — weekends, holidays — the **last published rate MUST be used and labelled with its actual date**. Never interpolated (R26.8).
- R32.4 A rate older than a configurable threshold (default 5 days) MUST be flagged wherever a converted figure is shown.
- R32.5 Manual rate override MUST be available per currency pair per date.
- R32.6 The app MUST retain full rate history, because historical net worth cannot be recomputed without it.

---

### R33 — Conversion rules

Which rate applies, and when:

| Situation | Rate used |
|---|---|
| A transaction in a foreign currency | The rate on its **trade date**, frozen at entry (R33.1) |
| A purchase of a foreign-currency holding | Trade-date rate, frozen into the lot's cost basis |
| Current market value of a foreign holding | **Today's** rate |
| Historical net worth on date D | The rate published on or before D |
| A transfer between accounts of different currencies | The **actual rate achieved**, entered by the user, not the reference rate — banks do not give reference rates |

- R33.1 A transaction's base amount MUST be frozen at entry and MUST NEVER be retrospectively revalued. Last month's grocery bill does not change because the rupee moved (FW8).
- R33.2 A cross-currency transfer MUST record both amounts and MUST derive and display the implied rate, so the spread the bank charged is visible.
- R33.3 The difference between the implied rate and the reference rate on that date SHOULD be shown as an FX cost, because it is one.

---

### R34 — FX gain versus asset gain

For any foreign-currency holding:

```
asset gain = (P₁ − P₀) × units × FX₀
fx gain    = (FX₁ − FX₀) × units × P₁
total      = asset gain + fx gain     (exactly)
```

**Worked example — 10 shares bought at USD 150 when USD/INR was 83.00; now USD 180 at 95.51:**

| | |
|---|---|
| Cost | ₹1,24,500.00 |
| Market value | ₹1,71,918.00 |
| Gain in USD terms | $300.00 |
| **Asset gain** | **₹24,900.00** |
| **FX gain** | **₹22,518.00** |
| **Total gain** | **₹47,418.00** |
| Residual | ₹0.00 |

**47% of the gain came from the exchange rate.** R34.1: this sentence, with the household's own numbers, MUST appear on any foreign holding whose FX contribution exceeds 20% of total gain. A single "+38%" figure would be true and useless.

- R34.2 Portfolio-level reporting MUST aggregate asset gain and FX gain separately across all foreign holdings.
- R34.3 The decomposition MUST be verified to sum exactly; a non-zero residual is a defect, not a rounding tolerance.

---

## 6. Price and rate providers

You asked for one hardcoded provider per need. Here they are, with what was verified and what was not.

### 6.1 The selection

| Need | Provider | Key | Status |
|---|---|---|---|
| **Indian mutual fund NAV** | **MFAPI** (`api.mfapi.in`), a JSON layer over AMFI's published NAVs | none | **[verified]** live-tested 26-08-2026 |
| **FX reference rates** | **Frankfurter** (`api.frankfurter.dev`), sourced from the ECB and other central banks | none | **[verified]** live-tested 26-08-2026 |
| **Equities & ETFs** (India via `.BSE`, plus US and global) | **Alpha Vantage** `GLOBAL_QUOTE` | free key | **[verified]** endpoint pattern, Indian `.BSE` suffix and rate limits confirmed from vendor docs; **response field names [unverified]** — confirm with a real key before coding |

### 6.2 Mutual funds — MFAPI

```
GET https://api.mfapi.in/mf/{schemeCode}/latest      # latest NAV
GET https://api.mfapi.in/mf/{schemeCode}             # full NAV history
GET https://api.mfapi.in/mf/search?q={query}         # find a scheme code
```

**Verified response, 26-08-2026** (`/mf/119551/latest`):

```json
{
  "meta": {
    "fund_house": "Aditya Birla Sun Life Mutual Fund",
    "scheme_type": "Open Ended Schemes",
    "scheme_category": "Debt Scheme - Banking and PSU Fund",
    "scheme_code": 119551,
    "scheme_name": "Aditya Birla Sun Life Banking & PSU Debt Fund - Direct Plan - IDCW-Re-investment",
    "isin_growth": "INF209KA12Z1",
    "isin_div_reinvestment": "INF209KA13Z9"
  },
  "data": [ { "date": "25-08-2026", "nav": "106.94190" } ],
  "status": "SUCCESS"
}
```

**Verified search response** (`/mf/search?q=parag parikh flexi cap`):

```json
[
  { "schemeCode": 122640, "schemeName": "Parag Parikh Flexi Cap Fund - Regular Plan - Growth" },
  { "schemeCode": 122639, "schemeName": "Parag Parikh Flexi Cap Fund - Direct Plan - Growth" }
]
```

**Notes.** No authentication [verified]. Rate-limited, and the vendor asks callers to cache [verified]. Dates are `DD-MM-YYYY`; NAV is a **string** and must be parsed as a decimal, never a float literal. The `isin_growth` field is what makes a provider swap survivable (R24.6). The search endpoint is the onboarding path: the user types a fund name, picks the exact plan, and the app stores the scheme code — critically, Direct and Regular plans are different scheme codes with different NAVs, so the picker must show the full name.

### 6.3 FX — Frankfurter

```
GET https://api.frankfurter.dev/v1/latest?base=USD&symbols=INR,EUR,GBP,SGD
GET https://api.frankfurter.dev/v2/rate/USD/INR
GET https://api.frankfurter.dev/v1/{YYYY-MM-DD}?base=USD&symbols=INR    # historical
```

**Verified responses, 26-08-2026:**

```json
{"amount":1.0,"base":"USD","date":"2026-08-25","rates":{"EUR":0.85749,"GBP":0.73358,"INR":95.42,"SGD":1.2703}}
```

```json
{"date":"2026-08-26","base":"USD","quote":"INR","rate":95.51}
```

**Notes.** No key, no monthly cap; rate-limited against abuse, and self-hostable if that ever bites [verified]. 201 currencies, 84 central bank sources, history to 1948, daily updates [verified from vendor docs]. **INR is present** [verified by live call]. Both a v1 and a v2 surface responded; **pin v2 and treat v1 as the fallback**, since v2 is what the current documentation describes. Rates are **daily reference rates published on working days** — R32.2 and R32.3 exist because of this.

### 6.4 Equities — Alpha Vantage

```
GET https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=RELIANCE.BSE&apikey={KEY}
GET https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=AAPL&apikey={KEY}
```

**[verified]** Indian equities are supported using the **`.BSE`** suffix, with `RELIANCE.BSE` given as the vendor's own example. US symbols need no suffix.

**[verified] Free tier limits: 5 requests per minute, 25 requests per day.** Exceeding them returns an error message rather than data; there is no account penalty.

**[unverified]** The exact `GLOBAL_QUOTE` field names. The vendor's demo key is restricted and would not return a sample. Confirm the response shape with a real key before writing the adapter, and do not assume field names from memory.

**The quota is the binding constraint.** 25 calls/day at one refresh per day per instrument caps direct-equity holdings at **25 instruments**. Mitigations, in order: mutual funds do not consume this quota at all (§6.2); refresh equities once daily after market close rather than on demand; cache aggressively; and mark low-priority holdings as weekly-refresh.

### 6.5 What was rejected, and why

| Candidate | Rejected because |
|---|---|
| **Yahoo Finance** (`query1.finance.yahoo.com`) | Automated access is disallowed by the site's robots rules; it is an undocumented internal endpoint with no terms permitting this use. Popular, and not defensible. |
| **Stooq** | Same — automated access disallowed; could not be verified. |
| **Twelve Data** | **[verified]** NSE/BSE coverage requires a paid tier. Its free tier (800 credits/day) covers US markets, forex and crypto only — a reasonable *secondary* for US holdings if Alpha Vantage's 25/day binds. |
| **NSE / BSE bhavcopy** | Officially published and free, but the download endpoints are header- and cookie-gated and the current URL pattern could not be verified this session. A good future adapter; not something to hardcode unverified. |
| **RBI reference rate** | Authoritative for USD/INR but publishes a narrow set of pairs; Frankfurter's breadth wins for a household that may hold several currencies. |

### 6.6 Provider behaviour

- P1 Each provider MUST sit behind a common **price provider interface**: given an instrument identifier and a date, return a price with its currency, date and source, or a typed failure.
- P2 Providers MUST be configurable per instrument, so an instrument can be moved between providers or to manual without losing history.
- P3 Every fetch MUST record: instrument, provider, request time, response status, and the price returned. This log is what makes a bad number explainable three months later.
- P4 Refresh schedule, per class: **mutual funds** once daily after 23:00 IST (AMFI publishes NAVs at end of day); **equities** once daily after the relevant market closes; **FX** once daily after 18:30 IST (the ECB publishes around 16:00 CET); **manual assets** never.
- P5 Refreshes MUST be jittered and MUST back off exponentially on failure, with a hard daily call ceiling per provider that the app enforces itself rather than discovering by being throttled.
- P6 A refresh MUST be triggerable manually, subject to the same ceiling, with the remaining daily quota shown.
- P7 All network calls MUST be server-side. The PWA MUST never call a price provider directly — it would leak an API key into the client and multiply calls by the number of devices.
- P8 No provider may receive holdings, quantities, or anything identifying the household. Only a symbol goes out.
- P9 The app MUST function with every provider disabled. Manual price entry is a first-class path (R26.6).

---

## 7. Modules

### F19 · Assets, holdings and net worth

- F19.1 The app MUST support asset accounts of every kind in R23.
- F19.2 The app MUST record holdings as units with FIFO lots (R24, R25).
- F19.3 The app MUST support purchase by amount-and-price or units-and-price, deriving the other (R24.3, R24.4).
- F19.4 The app MUST capitalise fees into cost basis by default, with an expense option (R24.5).
- F19.5 The app MUST support all corporate actions in R28, each reversible and attributed.
- F19.6 The app MUST refresh prices automatically per §6, cache them, store price history, and mark staleness (R26).
- F19.7 The app MUST support manual price entry and manual-only instruments (R26.6).
- F19.8 The app MUST compute unrealised gain, realised gain, absolute return and XIRR per holding, per account and per portfolio (R27).
- F19.9 The app MUST produce a net worth statement with the decomposition in R29.4 and a dated history (R29.2).
- F19.10 The app MUST enforce every invariant in R30.
- F19.11 The app MUST support asset allocation reporting by class, and SHOULD support it by geography and currency.
- F19.12 The app MUST show holding periods per lot (R25.5) without computing tax.
- F19.13 The app MUST export holdings, lots, price history and the net worth series to CSV (`02` F15).
- F19.14 The app SHOULD support importing a holdings statement (CAS, broker statement) as a batch of lots through the review queue (`04` §2). **[P3 — see §12 Q17.]**
- F19.15 The app MUST notify when: a price feed has failed N times, a manual valuation is stale, or a SIP instalment is due and its category is underfunded.
- F19.16 The app SHOULD show a portfolio-level XIRR across all holdings, labelled as money-weighted.

### F20 · Multi-currency

- F20.1 The app MUST support a base currency and per-account currencies (R31).
- F20.2 The app MUST keep all envelopes and Ready to Assign in base currency (R31.3).
- F20.3 The app MUST default foreign accounts to Tracking, with an explicit opt-in to Budget and daily revaluation (R31.4, R31.5).
- F20.4 The app MUST fetch, cache and retain FX rates with publication dates (R32).
- F20.5 The app MUST freeze transaction rates at trade date and never revalue history (R33.1).
- F20.6 The app MUST record both amounts on a cross-currency transfer and display the implied rate (R33.2).
- F20.7 The app MUST decompose foreign holding gains into asset and FX components that sum exactly (R34).
- F20.8 The app MUST flag stale rates wherever converted figures appear (R32.4).
- F20.9 The app MUST support manual rate override per pair per date (R32.5).
- F20.10 The app MUST display which currency any figure is in whenever more than one currency exists in the household.

---

## 8. Screens

Extends `03-screens-and-flows.md` and `06` §8.

### S13 · Portfolio

**List:** holdings grouped by asset account, or by asset class (toggle). Per row: instrument name, units, average cost, latest price with its date, market value, unrealised gain in ₹ and %, and a staleness chip where relevant. Footer: total invested, total market value, total unrealised gain, portfolio XIRR.

**S13a · Holding detail.** Four tabs.

| Tab | Contents |
|---|---|
| **Overview** | Units, average cost, latest price and date, market value, unrealised gain, absolute return, **XIRR as the headline**. For a foreign holding, the asset-gain/FX-gain split with the R34.1 sentence. |
| **Lots** | Every purchase: date, units, price, fees, cost, holding period, current value, gain. FIFO order made visible. |
| **Activity** | Purchases, sales, dividends, corporate actions, with realised gains on sales. |
| **Price** | Price history chart with the source named, plus manual override and provider selection. |

**S13b · Add holding sheet.** Instrument search (calling the provider's search where it has one — §6.2) → pick the exact scheme or symbol, with the full name shown so Direct and Regular are distinguishable → then amount-or-units, price, date, fees, and the account paid from.

**S13c · Record sale sheet.** Units to sell, price, date, charges → **FIFO preview showing exactly which lots are consumed and the realised gain**, before confirming.

### S14 · Net worth

- The headline figure with its as-of date and the staleness of its worst input.
- A stacked area chart of net worth over time, assets above the line and liabilities below.
- The change-since-last-period decomposition (R29.4) as a small waterfall: saved · market · FX · debt repaid.
- The statement itself, grouped by class, expandable to accounts.
- Asset allocation by class, and by currency where more than one exists.

### Additions to existing screens

- **Accounts (S2):** asset accounts get their own section, showing market value and price date.
- **Budget (S1):** unchanged, deliberately. FW3 forbids net worth here.
- **Review (S4):** new items — price feed failing, manual valuation stale, FX rate stale, corporate action detected but unapplied.
- **Reports (S6):** asset allocation, portfolio performance, realised gains by period, and net worth trend.
- **Settings (S11):** base currency, provider configuration, API keys, refresh schedules, staleness thresholds.

---

## 9. Journeys

**J16 · Adding a SIP.** Portfolio → Add holding → search "parag parikh flexi cap" → the picker returns both plans with their scheme codes; select *Direct Plan - Growth* → enter ₹25,000 monthly on the 5th, funded from the Investments category → the app creates a schedule (`02` F7), and each instalment creates a lot at that day's NAV, fetched automatically. The budget sees ₹25,000 leaving a category, never a portfolio value.

**J17 · The daily refresh.** At 23:00 IST the app fetches NAVs for every fund; at 18:30 it fetches FX. Nothing else happens. No notification, no badge — a price moving is not an event. The portfolio screen simply shows fresh numbers with today's date next time it is opened.

**J18 · Selling units.** S13c → sell 400 units at 86.40 → preview: *"FIFO takes 312.500 units from 05-01-2026 at ₹80.00 and 87.500 units from 05-02-2026 at ₹82.50. Realised gain ₹2,341.25. Both lots held under 12 months."* → confirm → proceeds land in savings and appear in Ready to Assign as income needing assignment (FW5).

**J19 · A foreign holding.** Add 10 shares of a US stock at $150 with USD/INR 83.00 on the trade date → the rate is frozen into the lot. Months later the holding shows a ₹47,418 gain, with: *"₹24,900 from the share price and ₹22,518 from the exchange rate — 47% of your gain came from the rupee weakening, not the investment."*

**J20 · Net worth review.** Monthly, S14 → net worth ₹36,69,211 → the waterfall shows: +₹42,000 saved, +₹8,400 market, −₹1,200 FX, +₹29,000 debt repaid. Four numbers that mean four different things, which a single "+₹78,200" would have hidden.

---

## 10. Edge cases

| Case | Required behaviour |
|---|---|
| Price feed returns a wildly wrong price | Reject a move beyond a configurable sanity band (default ±25% in one day) into Review rather than into the portfolio |
| NAV published for a date already recorded, with a different value | AMFI restatements happen; keep both, use the later, log the change |
| Direct vs Regular plan confusion | The picker always shows the full scheme name; the app never guesses a plan |
| Instrument delisted or scheme wound up | Freeze at last price, mark inactive, keep in history; do not zero it |
| Selling more units than held | Refuse with the actual holding stated |
| A lot with zero cost (bonus units) | Valid; realised gain equals full proceeds. Must not divide by zero in average cost. |
| Fractional shares | Supported; units carry decimals for every instrument type |
| Two accounts holding the same instrument | Separate holdings, separate lots; aggregated only in portfolio-level views |
| FX rate missing for a historical date | Use the last published rate on or before it, labelled (R32.3) |
| Base currency change requested after data exists | Refuse by default; offer an explicit, warned migration that revalues nothing historical |
| Every provider down for a week | Everything still works on cached prices with staleness shown (FW9) |
| API key absent or invalid | Equity holdings fall back to manual prices; mutual funds and FX are unaffected, since neither needs a key |

---

## 11. Verification

Every figure in this document was computed, and the computation ships beside it as **`verify_portfolio.py`**. It exits non-zero if any figure has drifted.

```
python verify_portfolio.py                        # verify every figure here
python verify_portfolio.py xirr                   # absolute return vs XIRR on the worked SIP
python verify_portfolio.py fx 150 180 83 95.51 10 # the R34 decomposition
```

| Example | Result |
|---|---|
| SIP units | 312.500 · 303.030 · 320.513 → **936.043 units**, ₹75,000 invested, avg cost 80.12 |
| Value at NAV 86.40 | **₹80,874.13** · unrealised **₹5,874.13** · absolute **7.83%** · **XIRR 14.51%** |
| FIFO sale, 400 units | proceeds ₹34,560.00 · cost ₹32,218.75 · **realised ₹2,341.25** · 536.043 units left |
| Foreign holding | cost ₹1,24,500 · value ₹1,71,918 · **asset ₹24,900 + FX ₹22,518 = ₹47,418**, residual **₹0.00** |
| Net worth | assets ₹85,29,792.13 − liabilities ₹48,60,581.00 = **₹36,69,211.13** |

All 24 figures verify as at 26-08-2026.

Precision: units carry three decimals, prices and money carry unrounded values internally, and rounding is display-only. The FX decomposition residual is asserted to be exactly zero, not merely small.

---

## 12. Open questions — closed 26-08-2026

Full answers in `09-decisions-log.md` §3.

| # | Decision | Effect on this document |
|---|---|---|
| Q15 | R30 firewall is **not** a build-blocking test | R30 stays a documented invariant and a review item. `02` N11–N12 forbid the failure modes. Accepted risk — `09` §7. |
| Q16 | Portfolio is **mostly mutual funds**, few or no direct stocks | **MFAPI (§6.2) is primary and near-sufficient.** Alpha Vantage (§6.4) becomes optional; its 25-calls/day limit no longer binds. The app MUST work with no equity API key configured. |
| Q17 | **CDSL CAS is the primary holdings source** | F19.14 upgraded from *SHOULD, P3* to **MUST, P1**. Password-protected PDF, password supplied per import and never stored (`04` PR5). Rows land in the review queue and reconcile against existing holdings rather than duplicating them. Manual lot entry remains the fallback. |
| Q18 | **₹-only accounts, with USD charges on cards** | No foreign Budget account exists. **R31.5 (daily revaluation) is specified but unused — do not build it.** R33.1 frozen trade-date rates DO apply, to USD card transactions. Frankfurter (§6.3) is still required for those. R34 (asset vs FX gain) is built but unexercised until a USD-priced holding appears. |
| Q19 | Property **at cost**, manual revaluation | R23.2 confirmed as written. |
| Q20 | Holding periods **shown** per lot | R25.5 confirmed. The app classifies nothing and computes no tax. |

---

## 13. Sources

- [MFapi.in — free India mutual fund API](https://www.mfapi.in/) · [documentation](https://www.mfapi.in/docs/) — endpoints and live responses verified 26-08-2026
- [Frankfurter — free exchange rates API](https://frankfurter.dev/) — endpoints, coverage and live INR rate verified 26-08-2026
- [Alpha Vantage — API documentation](https://www.alphavantage.co/documentation/) — `GLOBAL_QUOTE` pattern and `.BSE` Indian symbol suffix verified 26-08-2026
- [Alpha Vantage API request limits — Macroption](https://www.macroption.com/alpha-vantage-api-limits/) — free tier 5/minute, 25/day verified 26-08-2026
- [Twelve Data — trial plan](https://support.twelvedata.com/en/articles/5335783-trial) · [NSE India coverage](https://twelvedata.com/exchanges/XNSE) — Indian exchanges confirmed as paid-tier only
