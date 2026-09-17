/**
 * S13 · Portfolio · S14 · Net worth.
 *
 * `07` §8: XIRR is the headline return, every value carries its price date
 * (R26.2 — "a portfolio value with no as-of date is not a number, it is a
 * rumour"), and a foreign holding states its FX split in words.
 *
 * Deliberately absent from the budget screen. FW3 forbids it there.
 */

import { html, raw, when, type SafeHtml } from "../../http/html.ts";
import { formatPaise, formatCompact, type Paise } from "../../core/money.ts";
import { formatDate, type IsoDate } from "../../core/dates.ts";
import { formatUnits, formatPrice } from "../../portfolio/holdings.ts";
import type { HoldingView } from "../../domain/assets.ts";
import { ASSET_LABELS, ASSET_SUBTYPES, type AssetSubtype } from "../../domain/assets.ts";
import { donutChart, lineChart, seriesColor, waterfall } from "../charts.ts";
import type {
  NetWorthStatement, NetWorthChange, NetWorthGroup, Snapshot,
} from "../../domain/networth.ts";

export interface PortfolioRow {
  view: HoldingView;
  accountName: string;
}

export function renderPortfolio(opts: {
  rows: PortfolioRow[];
  manualAssets: {
    id: string; name: string; subtype: string; value: Paise;
    /** Null until the first valuation is recorded (B101). */
    asOf: IsoDate | null;
    stale: boolean;
    valued: boolean;
  }[];
  portfolioXirr: number | null;
}): SafeHtml {
  const invested = opts.rows.reduce((sum, r) => sum + r.view.costBasis, 0);
  const value = opts.rows.reduce((sum, r) => sum + r.view.marketValue, 0);
  const gain = value - invested;

  if (opts.rows.length === 0 && opts.manualAssets.length === 0) {
    return html`
      <div class="row-between" style="margin-bottom:1rem"><h1>Portfolio</h1></div>
      <div class="card empty-state">
        <div class="empty-icon" aria-hidden="true">△</div>
        <h2>Nothing tracked yet</h2>
        <p>
          Holdings are recorded as <strong>units</strong>, not as a rupee balance you
          retype each month — that is what makes cost basis, realised gains and
          XIRR computable at all.
        </p>
        <p>
          <!-- Q17: the CAS is the primary route in, so it leads. -->
          <a class="button button-primary" href="/portfolio/cas">Import a CAS</a>
          <a class="button" href="/portfolio/add">Add a holding by hand</a>
        </p>
      </div>
    `;
  }

  return html`
    <div class="row-between" style="margin-bottom:1rem">
      <h1>Portfolio</h1>
      <div class="row">
        <form method="post" action="/portfolio/refresh">
          <button class="button-small" type="submit">Refresh prices</button>
        </form>
        <a class="button" href="/portfolio/allocation">Allocation</a>
        <!--
          Three exports, three questions: holdings is what you hold, lots is what
          each parcel cost and when — the one a capital-gains return is built
          from — and prices is the history behind every valuation. Two of the
          three were routed, tested and linked from nowhere.
        -->
        <a class="button" href="/portfolio/holdings.csv">Holdings CSV</a>
        <a class="button" href="/portfolio/lots.csv">Lots CSV</a>
        <a class="button" href="/portfolio/prices.csv">Prices CSV</a>
        <a class="button" href="/portfolio/cas">Import a CAS</a>
        <a class="button" href="/portfolio/asset/new">Add an asset</a>
        <a class="button button-primary" href="/portfolio/add">Add a holding</a>
      </div>
    </div>

    <div class="card">
      <div class="row" style="gap:2rem;flex-wrap:wrap">
        ${figure("Invested", invested)}
        ${figure("Market value", value)}
        ${figure("Unrealised gain", gain)}
        ${when(opts.portfolioXirr !== null, () => html`
          <div>
            <div class="faint">XIRR <span class="chip">money-weighted</span></div>
            <strong class="amount" style="font-size:1.15rem">
              ${opts.portfolioXirr!.toFixed(2)}%
            </strong>
          </div>
        `)}
      </div>
    </div>

    ${when(opts.rows.length > 1, () => html`
      <section class="card">
        <h2>By holding</h2>
        ${donutChart({
          title: "Portfolio by holding",
          slices: opts.rows.map((r) => ({ label: r.view.instrument.name, value: r.view.marketValue })),
          centerLabel: formatCompact(value),
        })}
      </section>
    `)}

    ${when(opts.rows.length > 0, () => html`
      <section class="card">
        <h2>Holdings</h2>
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Instrument</th>
                <th scope="col" class="num">Units</th>
                <th scope="col" class="num">Avg cost</th>
                <th scope="col" class="num">Price</th>
                <th scope="col" class="num">Value</th>
                <th scope="col" class="num">Gain</th>
              </tr>
            </thead>
            <tbody>
              ${opts.rows.map((r) => renderHoldingRow(r))}
            </tbody>
          </table>
        </div>
      </section>
    `)}

    ${when(opts.manualAssets.length > 0, () => html`
      <section class="card">
        <div class="row-between">
          <h2>Other assets</h2>
          ${when(opts.manualAssets.length > 1, () => html`
            <a class="button button-small" href="/portfolio/valuations">Update all</a>
          `)}
        </div>
        <p class="faint" style="margin-top:-.25rem">
          Valued by hand. Each keeps a dated history, so net worth over time is
          real rather than today's figure applied backwards.
        </p>
        ${opts.manualAssets.map(
          (a) => html`
            <div class="row-between" style="padding:.5rem 0;border-top:1px solid var(--border)">
              <div>
                <strong>${a.name}</strong>
                <span class="chip">${ASSET_LABELS[a.subtype as AssetSubtype] ?? a.subtype}</span>
                <div class="faint">
                  ${a.valued
                    ? html`
                        as of ${formatDate(a.asOf!)}
                        ${when(a.stale, () => html`
                          <span class="chip chip-warning">not valued recently</span>
                        `)}
                        · <a href="/portfolio/asset/${a.id}/revalue">Revalue</a>
                      `
                    : html`
                        <!-- B101 · Created and never valued. It used to vanish. -->
                        <span class="chip chip-warning">no value yet</span>
                        · <a href="/portfolio/asset/${a.id}/revalue">Say what it's worth</a>
                      `}
                </div>
              </div>
              <strong class="amount ${a.valued ? "" : "faint"}">
                ${a.valued ? formatPaise(a.value) : "—"}
              </strong>
            </div>
          `,
        )}
      </section>
    `)}
  `;
}

/**
 * B51 · Add a hand-valued asset (a flat, gold, a deposit, a receivable).
 *
 * `createAssetAccount` was reachable only through `POST /assets/new`, which the
 * `/assets/` static-asset guard shadowed — so the whole non-market half of net
 * worth was seed-only. The route moved to `/portfolio/asset/new`; this is its
 * form.
 */
/** H2 / H2.2 · Whose it is, and whether the household sees it. */
export function renderHolderFields(
  members: { id: string; name: string }[],
  current: { holder?: string | null; visibility?: string | null } = {},
): SafeHtml {
  if (members.length < 2) return raw("");
  return html`
    <div class="grid-2">
      <div class="field">
        <label for="holder_member_id">Whose is it</label>
        <select id="holder_member_id" name="holder_member_id">
          <option value="">The household's, jointly</option>
          ${members.map(
            (m) => html`
              <option value="${m.id}" ${raw(current.holder === m.id ? "selected" : "")}>
                ${m.name}
              </option>
            `,
          )}
        </select>
      </div>
      <div class="field">
        <label for="visibility">Who can see it</label>
        <select id="visibility" name="visibility">
          <option value="household" ${raw(current.visibility !== "private" ? "selected" : "")}>
            Shared with the household
          </option>
          <option value="private" ${raw(current.visibility === "private" ? "selected" : "")}>
            Private to whoever holds it
          </option>
        </select>
        <p class="field-hint">
          <strong>Shared</strong> means everyone in the household sees it, with
          whoever holds it shown as a tag. <strong>Private</strong> means only the
          holder sees it at all — it is left out of everyone else's screens and out
          of their totals, because a total that included it would give it away.
        </p>
      </div>
    </div>
  `;
}

export function renderNewAssetForm(opts: {
  today: IsoDate;
  members?: { id: string; name: string }[];
  error?: string | null;
}): SafeHtml {
  return html`
    <h1>Add an asset</h1>
    <p class="faint">
      Something valued by hand — property, gold, a fixed deposit, money owed to you.
      It counts towards net worth and keeps a dated history; it never touches the budget.
    </p>
    ${when(opts.error, () => html`<p class="notice notice-error">${opts.error}</p>`)}
    <form method="post" action="/portfolio/asset/new" class="card">
      <div class="field">
        <label for="name">Name</label>
        <input id="name" name="name" autocomplete="off" required autofocus
               placeholder="Flat in Kochi, Sovereign gold, SBI FD…">
      </div>
      ${renderHolderFields(opts.members ?? [])}
      <div class="grid-2">
        <div class="field">
          <label for="subtype">Kind</label>
          <select id="subtype" name="subtype">
            ${ASSET_SUBTYPES.filter((s) => s !== "investment").map(
              (s) => html`<option value="${s}">${ASSET_LABELS[s]}</option>`,
            )}
          </select>
        </div>
        <div class="field">
          <label for="value">Current value</label>
          <input id="value" name="value" class="amount-input" type="text"
                 inputmode="decimal" autocomplete="off" placeholder="0.00">
        </div>
      </div>
      <div class="field">
        <label for="as_of">Valued as of</label>
        <input id="as_of" name="as_of" type="date" autocomplete="off"
               value="${opts.today}">
      </div>
      <button class="button-primary" type="submit">Add asset</button>
      <a class="button button-quiet" href="/portfolio">Cancel</a>
    </form>
  `;
}

/** B51 · Record a fresh dated valuation for a hand-valued asset (R23.2). */
/**
 * B101 · R23.2 · Update every hand-valued pot in one sitting.
 *
 * Gold with one provider, gold with another, a pension balance — three pots
 * that each send a monthly statement and none of which any feed can price. One
 * at a time through the single-asset form is three round trips for what is
 * really one monthly chore, which is how valuations come to be six months old.
 *
 * Each row keeps its own date, because the statements do not all arrive on the
 * same day, and a valuation dated wrongly is worse than one left alone: R23.2
 * keeps dated history so net worth over time is real.
 */
export function renderValuations(opts: {
  assets: {
    id: string; name: string; subtype: string;
    value: Paise; asOf: IsoDate | null; stale: boolean; valued: boolean;
    /** R32 · The currency the number is in, when it is not the base one. */
    currency?: string;
  }[];
  today: IsoDate;
}): SafeHtml {
  if (opts.assets.length === 0) {
    return html`
      <h1>Update valuations</h1>
      <div class="card empty-state">
        <p>Nothing here is valued by hand — everything is priced from a feed.</p>
        <p><a class="button" href="/portfolio">Back to the portfolio</a></p>
      </div>
    `;
  }

  const needing = opts.assets.filter((a) => !a.valued || a.stale).length;

  return html`
    <h1>Update valuations</h1>
    <p class="muted">
      What each of these is worth today. Leave a box empty to leave that one
      alone — nothing is changed unless you put a number in it.
      ${when(needing > 0, () => html`
        <strong>${needing}</strong> ${needing === 1 ? "needs" : "need"} attention.
      `)}
    </p>

    <form method="post" action="/portfolio/valuations" class="card">
      ${opts.assets.map(
        (a) => html`
          <div style="padding:.7rem 0;border-top:1px solid var(--border)">
            <div class="row-between" style="gap:1rem;flex-wrap:wrap;align-items:flex-end">
              <div style="min-width:0">
                <strong>${a.name}</strong>
                <span class="chip">${ASSET_LABELS[a.subtype as AssetSubtype] ?? a.subtype}</span>
                <div class="faint">
                  ${a.valued
                    ? html`
                        last ${formatPaise(a.value)} on ${formatDate(a.asOf!)}
                        ${when(a.stale, () => html`<span class="chip chip-warning">not valued recently</span>`)}
                      `
                    : html`<span class="chip chip-warning">no value yet</span>`}
                </div>
              </div>
              <div class="row" style="gap:.5rem;align-items:flex-end">
                <div class="field" style="margin:0">
                  <!-- R32 · Whose unit. Net worth converts a foreign account at
                       the dated rate, so the number typed here has to be in the
                       account's own currency and the label has to say so. -->
                  <label style="font-size:.75rem" for="val-${a.id}">
                    Worth now${when(a.currency && a.currency !== "INR", () => html` (${a.currency})`)}
                  </label>
                  <input id="val-${a.id}" name="value-${a.id}" class="amount-input"
                         type="text" inputmode="decimal" autocomplete="off"
                         style="max-width:9rem" placeholder="leave blank to skip">
                </div>
                <div class="field" style="margin:0">
                  <label style="font-size:.75rem" for="asof-${a.id}">As of</label>
                  <input type="date" id="asof-${a.id}" name="asof-${a.id}" style="max-width:8rem"
                         value="${opts.today}">
                </div>
              </div>
            </div>
          </div>
        `,
      )}
      <button class="button-primary" type="submit" style="margin-top:.75rem">Save valuations</button>
      <a class="button button-quiet" href="/portfolio">Cancel</a>
    </form>
  `;
}

export function renderRevalueAsset(opts: {
  asset: { id: string; name: string; value: Paise; asOf: IsoDate; currency?: string };
  today: IsoDate;
}): SafeHtml {
  return html`
    <h1>Revalue ${opts.asset.name}</h1>
    <p class="faint">
      Last valued at ${formatPaise(opts.asset.value)} as of ${formatDate(opts.asset.asOf)}.
      A new valuation is added to the history — the old one is kept, so net
      worth over time stays accurate.
    </p>
    <form method="post" action="/portfolio/asset/${opts.asset.id}/revalue" class="card">
      <div class="grid-2">
        <div class="field">
          <!-- R32 · In the account's own currency; net worth converts it. -->
          <label for="value">
            New value${when(opts.asset.currency && opts.asset.currency !== "INR",
                            () => html` (${opts.asset.currency})`)}
          </label>
          <input id="value" name="value" class="amount-input" type="text"
                 inputmode="decimal" autocomplete="off" required autofocus placeholder="0.00">
        </div>
        <div class="field">
          <label for="as_of">As of</label>
          <input id="as_of" name="as_of" type="date" autocomplete="off"
                 value="${opts.today}">
        </div>
      </div>
      <button class="button-primary" type="submit">Save valuation</button>
      <a class="button button-quiet" href="/portfolio">Cancel</a>
    </form>
  `;
}

/**
 * B51 · Enter a price for a market instrument by hand (R26).
 *
 * The holding page's "Enter one" link pointed at `/portfolio/:id/price`, which
 * did not exist. Useful when a feed has no quote — an unlisted bond, a fund the
 * provider does not carry.
 */
export function renderManualPrice(opts: {
  holdingId: string;
  instrumentName: string;
  currentPrice: string;
  today: IsoDate;
}): SafeHtml {
  return html`
    <h1>Price ${opts.instrumentName}</h1>
    <p class="faint">
      Enter the price per unit in the instrument's own currency. It is stored against
      the date, exactly like a fetched price, and never silently overwritten.
    </p>
    <form method="post" action="/portfolio/${opts.holdingId}/price" class="card">
      <div class="grid-2">
        <div class="field">
          <label for="price">Price per unit</label>
          <input id="price" name="price" class="amount-input" type="text"
                 inputmode="decimal" autocomplete="off" required autofocus
                 value="${opts.currentPrice}" placeholder="0.00">
        </div>
        <div class="field">
          <label for="as_of">As of</label>
          <input id="as_of" name="as_of" type="date" autocomplete="off"
                 value="${opts.today}">
        </div>
      </div>
      <button class="button-primary" type="submit">Save price</button>
      <a class="button button-quiet" href="/portfolio/${opts.holdingId}">Cancel</a>
    </form>
  `;
}

function renderHoldingRow(row: PortfolioRow): SafeHtml {
  const v = row.view;
  return html`
    <tr>
      <td>
        <a href="/portfolio/${v.holding.id}">${v.instrument.name}</a>
        <div class="faint">${row.accountName}</div>
      </td>
      <td class="num">${formatUnits(v.units)}</td>
      <td class="num">
        <!-- The price paid in the instrument's own currency, as a broker shows
             it. For a foreign holding the base-currency cost per unit would
             mean something different and read as wrong. -->
        ${v.instrument.currency === "INR" ? "₹" : "$"}${formatPrice(v.averageUnitPrice)}
      </td>
      <td class="num">
        ${v.quote
          ? html`${v.instrument.currency === "INR" ? "₹" : "$"}${formatPrice(v.quote.price)}`
          : html`<span class="faint">—</span>`}
        ${when(v.quote, () => html`
          <!-- R26.2: a value with no as-of date is a rumour, not a number. -->
          <div class="faint">
            ${formatDate(v.quote!.asOf)}
            ${when(v.quote!.stale, () => html`<span class="chip chip-warning">stale</span>`)}
          </div>
        `)}
      </td>
      <td class="num amount">${formatPaise(v.marketValue)}</td>
      <td class="num amount ${v.unrealisedGain < 0 ? "amount-negative" : "amount-positive"}">
        ${formatPaise(v.unrealisedGain)}
        <div class="faint">${v.absoluteReturn.toFixed(1)}%</div>
      </td>
    </tr>
  `;
}

function figure(label: string, amount: Paise): SafeHtml {
  return html`
    <div>
      <div class="faint">${label}</div>
      <strong class="amount ${amount < 0 ? "amount-negative" : ""}" style="font-size:1.15rem">
        ${formatPaise(amount)}
      </strong>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// S13a · Holding detail
// ---------------------------------------------------------------------------

/**
 * B72 · R28.2 · A split or a bonus issue.
 *
 * `recordSplit` adjusts every lot and the price history together, so a chart
 * does not show a cliff where no value was lost. It was written and tested and
 * had no screen, which meant a 1:5 split left the portfolio reporting a fifth
 * of its real units until someone edited the database by hand.
 */
export function renderSplitForm(opts: {
  holdingId: string;
  instrumentName: string;
  units: string;
  today: IsoDate;
}): SafeHtml {
  return html`
    <h1>Split or bonus · ${opts.instrumentName}</h1>
    <p class="faint">
      You hold ${opts.units} units. A split or a bonus changes how many units
      you hold and what each one cost — never what the holding is worth. Every lot and the whole price history move together, so the chart stays
      accurate.
    </p>
    <form method="post" action="/portfolio/${opts.holdingId}/split" class="card">
      <div class="grid-2">
        <div class="field">
          <label for="ratio">New units for each one held</label>
          <input id="ratio" name="ratio" class="amount-input" type="text"
                 inputmode="decimal" autocomplete="off" required autofocus placeholder="5">
          <p class="field-hint">
            A 1:5 split is 5. A 1:1 bonus is 2 — one new unit alongside the one
            you held.
          </p>
        </div>
        <div class="field">
          <label for="split-date">Effective from</label>
          <input id="split-date" name="date" type="date" autocomplete="off"
                 value="${opts.today}">
        </div>
      </div>
      <div class="field">
        <label for="split-kind">Which is it?</label>
        <select id="split-kind" name="kind">
          <option value="split">A split</option>
          <option value="bonus">A bonus issue</option>
        </select>
      </div>
      <button class="button-primary" type="submit">Record it</button>
      <a class="button button-quiet" href="/portfolio/${opts.holdingId}">Cancel</a>
    </form>
  `;
}

/**
 * R28 · A merger, which is the corporate action Indian fund investors actually
 * meet — two schemes amalgamate and the units are reissued at a ratio.
 *
 * `applyMerger` was written and called by nothing, and the events table had
 * allowed the kind since the day it was created. Without a screen the household
 * had to choose between a wrong unit count and recording a sale that never
 * happened — which would manufacture a capital gain and restart the clock on
 * long-term treatment.
 */
export function renderMergerForm(opts: {
  holdingId: string;
  instrumentName: string;
  units: string;
  today: IsoDate;
  instruments: { id: string; name: string }[];
}): SafeHtml {
  return html`
    <h1>Merger &middot; ${opts.instrumentName}</h1>
    <p class="faint">
      You hold ${opts.units} units. When a scheme merges into another, your units
      are reissued at a ratio — and your <strong>original cost and purchase dates
      carry forward</strong>. Nothing is sold, so nothing is realised and the
      holding period is not reset.
    </p>
    <form method="post" action="/portfolio/${opts.holdingId}/merge" class="card">
      <div class="grid-2">
        <div class="field">
          <label for="merge-ratio">New units for each one held</label>
          <input id="merge-ratio" name="ratio" class="amount-input" type="text"
                 inputmode="decimal" autocomplete="off" required autofocus placeholder="0.8">
          <p class="field-hint">
            The letter states it as an exchange ratio: 8 units of the new scheme
            for every 10 held is 0.8.
          </p>
        </div>
        <div class="field">
          <label for="merge-date">Effective from</label>
          <input id="merge-date" name="date" type="date" autocomplete="off"
                 value="${opts.today}">
        </div>
      </div>
      <div class="field">
        <label for="merge-into">Merged into</label>
        <select id="merge-into" name="into_instrument_id">
          <option value="">Keep it under its own name</option>
          ${opts.instruments.map((i) => html`<option value="${i.id}">${i.name}</option>`)}
        </select>
        <p class="field-hint">
          Pick the surviving scheme if you already track it. Otherwise add it
          first, or leave this alone and rename the instrument later — the units
          and the cost are what matter here.
        </p>
      </div>
      <button class="button-primary" type="submit">Record the merger</button>
      <a class="button button-quiet" href="/portfolio/${opts.holdingId}">Cancel</a>
    </form>
  `;
}

export function renderHoldingDetail(opts: {
  view: HoldingView;
  accountName: string;
  history: { asOf: IsoDate; price: number; source: string }[];
  today: IsoDate;
}): SafeHtml {
  const v = opts.view;

  return html`
    <div class="row-between" style="margin-bottom:1rem">
      <div>
        <h1 style="margin-bottom:.15rem">${v.instrument.name}</h1>
        <p class="faint" style="margin:0">
          ${opts.accountName} · ${formatUnits(v.units)} units
          ${when(v.instrument.isin, () => html` · ${v.instrument.isin}`)}
        </p>
      </div>
      <div class="row">
        <a class="button" href="/portfolio/${v.holding.id}/split">Split or bonus</a>
        <a class="button" href="/portfolio/${v.holding.id}/merge">Merger</a>
        <a class="button button-primary" href="/portfolio/${v.holding.id}/sell">Sell units</a>
      </div>
    </div>

    <section class="card">
      <h2>Where it stands</h2>
      <div class="row" style="gap:2rem;flex-wrap:wrap">
        ${figure("Invested", v.costBasis)}
        ${figure("Market value", v.marketValue)}
        ${figure("Unrealised gain", v.unrealisedGain)}
        <div>
          <!-- R27.1: XIRR is the headline for anything with more than one lot. -->
          <div class="faint">XIRR <span class="chip">money-weighted</span></div>
          <strong class="amount" style="font-size:1.15rem">
            ${v.xirr !== null ? `${v.xirr.toFixed(2)}%` : "—"}
          </strong>
        </div>
      </div>

      <p class="field-hint">
        ${v.quote
          ? html`Priced at ₹${formatPrice(v.quote.price)} as of
                 <strong>${formatDate(v.quote.asOf)}</strong> from ${v.quote.source}.
                 ${when(v.quote.stale, () => html`
                   That price is older than expected — the figures above still stand,
                   they are just as of that date.
                 `)}`
          : html`No price recorded yet, so the value above uses average cost.
                 <a href="/portfolio/${v.holding.id}/price">Enter one</a>`}
      </p>

      ${when(v.xirr !== null && Math.abs(v.absoluteReturn - v.xirr!) >= 2, () => html`
        <p class="field-hint">
          Absolute return says ${v.absoluteReturn.toFixed(2)}%, XIRR says
          ${v.xirr!.toFixed(2)}%. The difference is time: absolute return treats
          money you invested last month as though it had been in since the start.
        </p>
      `)}

      ${when(v.decomposition?.sentence, () => html`
        <!-- R34.1: required above 20%, because "+38%" would be true and useless. -->
        <p class="notice notice-info">
          <strong>${v.decomposition!.sentence}</strong><br>
          ${formatPaise(v.decomposition!.assetGain)} came from the price and
          ${formatPaise(v.decomposition!.fxGain)} from the exchange rate,
          totalling ${formatPaise(v.decomposition!.totalGain)}.
        </p>
      `)}

      ${when(v.realisedGain !== 0 || v.dividends !== 0, () => html`
        <div class="row" style="gap:2rem;flex-wrap:wrap;margin-top:.5rem">
          <!-- R27.4: realised and unrealised are never summed unlabelled. -->
          ${when(v.realisedGain !== 0, () => figure("Realised gain", v.realisedGain))}
          ${when(v.dividends !== 0, () => figure("Dividends received", v.dividends))}
        </div>
      `)}
    </section>

    <section class="card">
      <h2>Lots</h2>
      <p class="faint" style="margin-top:-.25rem">
        Oldest first — the order a sale consumes them in. Holding periods are shown
        so you can see what is long-term; this app classifies nothing and computes
        no tax.
      </p>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Bought</th>
              <th scope="col" class="num">Units</th>
              <th scope="col" class="num">Price</th>
              <th scope="col" class="num">Cost</th>
              <th scope="col" class="num">Held</th>
            </tr>
          </thead>
          <tbody>
            ${v.lots.map(
              (lot) => html`
                <tr>
                  <td>${formatDate(lot.tradeDate)}</td>
                  <td class="num">${formatUnits(lot.units)}</td>
                  <td class="num">₹${formatPrice(lot.price)}</td>
                  <td class="num amount">${formatPaise(lot.cost)}</td>
                  <td class="num faint">${daysLabel(lot.tradeDate, opts.today)}</td>
                </tr>
              `,
            )}
          </tbody>
        </table>
      </div>
    </section>

    ${when(opts.history.length > 0, () => html`
      <section class="card">
        <h2>Price history</h2>
        <div class="table-scroll" style="max-height:18rem;overflow-y:auto">
          <table>
            <thead>
              <tr><th scope="col">Date</th><th scope="col" class="num">Price</th><th scope="col">Source</th></tr>
            </thead>
            <tbody>
              ${opts.history.map(
                (h) => html`
                  <tr>
                    <td>${formatDate(h.asOf)}</td>
                    <td class="num">₹${formatPrice(h.price)}</td>
                    <td class="faint">${h.source}</td>
                  </tr>
                `,
              )}
            </tbody>
          </table>
        </div>
      </section>
    `)}
  `;
}

function daysLabel(from: IsoDate, to: IsoDate): string {
  const days = Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000,
  );
  if (days < 365) return `${days}d`;
  return `${Math.floor(days / 365)}y ${days % 365}d`;
}

// ---------------------------------------------------------------------------
// S13c · The FIFO sale preview
// ---------------------------------------------------------------------------

export function renderSalePreview(opts: {
  view: HoldingView;
  preview: {
    consumed: { tradeDate: IsoDate; units: number; price: number; cost: Paise; holdingPeriodDays: number }[];
    proceeds: Paise;
    costOfUnitsSold: Paise;
    realisedGain: Paise;
    unitsRemaining: number;
    description: string;
  } | null;
  unitsToSell: string;
  priceInput: string;
  accounts: { id: string; name: string }[];
  today: IsoDate;
}): SafeHtml {
  const v = opts.view;

  return html`
    <h1>Sell ${v.instrument.name}</h1>
    <p class="muted">${formatUnits(v.units)} units held.</p>

    <form method="get" action="/portfolio/${v.holding.id}/sell" class="card">
      <div class="grid-2">
        <div class="field">
          <label for="units">Units to sell</label>
          <input id="units" name="units" type="text" inputmode="decimal"
                 value="${opts.unitsToSell}" required>
        </div>
        <div class="field">
          <label for="price">Price per unit</label>
          <input id="price" name="price" type="text" inputmode="decimal"
                 value="${opts.priceInput}" required>
        </div>
      </div>
      <button type="submit">Preview</button>
    </form>

    ${when(opts.preview, () => html`
      <div class="card">
        <h2>What this sells</h2>
        <!-- S13c: exactly which lots are consumed, before confirming. -->
        <p class="notice notice-info">${opts.preview!.description}</p>

        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">From</th>
                <th scope="col" class="num">Units</th>
                <th scope="col" class="num">Bought at</th>
                <th scope="col" class="num">Cost</th>
                <th scope="col" class="num">Held</th>
              </tr>
            </thead>
            <tbody>
              ${opts.preview!.consumed.map(
                (c) => html`
                  <tr>
                    <td>${formatDate(c.tradeDate)}</td>
                    <td class="num">${formatUnits(c.units)}</td>
                    <td class="num">₹${formatPrice(c.price)}</td>
                    <td class="num amount">${formatPaise(c.cost)}</td>
                    <td class="num faint">${c.holdingPeriodDays}d</td>
                  </tr>
                `,
              )}
            </tbody>
          </table>
        </div>

        <div class="row" style="gap:2rem;flex-wrap:wrap;margin-top:1rem">
          ${figure("Proceeds", opts.preview!.proceeds)}
          ${figure("Cost of those units", opts.preview!.costOfUnitsSold)}
          ${figure("Realised gain", opts.preview!.realisedGain)}
        </div>

        <form method="post" action="/portfolio/${v.holding.id}/sell" style="margin-top:1rem">
          <input type="hidden" name="units" value="${opts.unitsToSell}">
          <input type="hidden" name="price" value="${opts.priceInput}">
          <div class="grid-2">
            <div class="field">
              <label for="sale_date">Date of sale</label>
              <input id="sale_date" name="date" type="text" value="${formatDate(opts.today)}">
              <p class="field-hint">
                <!-- Realised gains are reported by financial year, so a sale
                     recorded a week late under today's date lands in the
                     wrong year's figure. -->
                Which financial year the realised gain belongs to follows this.
              </p>
            </div>
            <div class="field">
              <label for="charges">Brokerage and charges</label>
              <input id="charges" name="charges" class="amount-input" type="text"
                     inputmode="decimal" placeholder="0">
              <p class="field-hint">Taken off the proceeds and added to the cost.</p>
            </div>
          </div>
          <div class="field">
            <label for="to_account">Where do the proceeds land?</label>
            <select id="to_account" name="to_account_id">
              <option value="">Leave the cash outside the budget</option>
              ${opts.accounts.map((a) => html`<option value="${a.id}">${a.name}</option>`)}
            </select>
            <p class="field-hint">
              The <strong>full proceeds</strong> arrive as money to assign, not just the
              gain. Cash is cash — the gain is a separate fact about the past.
            </p>
          </div>
          <button class="button-primary" type="submit">Record the sale</button>
          <a class="button button-quiet" href="/portfolio/${v.holding.id}">Cancel</a>
        </form>
      </div>
    `)}
  `;
}

// ---------------------------------------------------------------------------
// S14 · Net worth
// ---------------------------------------------------------------------------

export function renderNetWorth(opts: {
  /** H2.3 · Whose figures these are. */
  scope?: "household" | "mine" | "joint";
  members?: { id: string; name: string }[];
  statement: NetWorthStatement;
  change: NetWorthChange | null;
  history: Snapshot[];
}): SafeHtml {
  const s = opts.statement;

  return html`
    <div class="row-between" style="margin-bottom:1rem">
      <h1>Net worth</h1>
      <div class="row">
        <!--
          F15 · The export existed and nothing linked to it, so the one figure
          people take to an accountant could only be got at by typing the URL.
        -->
        <a class="button button-small" href="/net-worth.csv">Export CSV</a>
        <form method="post" action="/net-worth/snapshot">
          <button class="button-small" type="submit">Snapshot today</button>
        </form>
      </div>
    </div>

    ${when((opts.members ?? []).length > 1, () => html`
      <div class="scope-tabs" style="margin-bottom:1rem">
        ${(["household", "mine", "joint"] as const).map(
          (v) => html`
            <a class="button button-small ${(opts.scope ?? "household") === v ? "button-primary" : ""}"
               href="/net-worth?whose=${v}">
              ${v === "household" ? "Everything I can see" : v === "mine" ? "Mine" : "Joint"}
            </a>
          `,
        )}
      </div>
      ${when(opts.scope === "household", () => html`
        <p class="faint" style="margin-top:-.5rem">
          Anything another member has marked private is left out — of the lines and
          of the total, because a total that included it would give it away.
        </p>
      `)}
    `)}

    <div class="card">
      <div class="faint">As of ${formatDate(s.asOf)}</div>
      <div class="rta-figure ${s.netWorth < 0 ? "amount-negative" : ""}">
        ${formatPaise(s.netWorth)}
      </div>
      ${when(s.hasStaleInputs, () => html`
        <!-- R29.1: the figure carries the staleness of its worst input. -->
        <p class="faint">
          Some inputs haven't been updated recently — the oldest is from
          ${formatDate(s.worstInputDate!)}. The figure is still the best available;
          it is just as of those dates.
        </p>
      `)}
    </div>

    ${s.untrackedAssetWarnings.map(
      (warning) => html`<p class="notice notice-warning">${warning}</p>`,
    )}

    ${when(opts.change, () => renderWaterfall(opts.change!))}

    <section class="card">
      <h2>Assets <span class="amount">${formatPaise(s.totalAssets)}</span></h2>
      ${when(s.assetGroups.filter((g) => g.total > 0).length > 1, () => donutChart({
        title: "What your assets are made of",
        slices: s.assetGroups.map((g) => ({ label: g.name, value: g.total })),
        centerLabel: formatCompact(s.totalAssets),
        centerSub: "assets",
      }))}
      ${s.assetGroups.map((g) => renderGroup(g))}
    </section>

    <section class="card">
      <h2>Liabilities <span class="amount">${formatPaise(s.totalLiabilities)}</span></h2>
      ${s.liabilityGroups.map((g) => renderGroup(g))}
    </section>

    ${when(opts.history.length > 1, () => renderHistory(opts.history))}
  `;
}

/** R29.4 · Four numbers that mean four different things. */
function renderWaterfall(change: NetWorthChange): SafeHtml {
  const parts: [string, Paise, string][] = [
    ["Money saved", change.moneySaved, "What you actually put aside"],
    ["Market movement", change.marketMovement, "Prices moving, not your doing"],
    ["Exchange rate", change.fxMovement, "The rupee moving, not your doing"],
    ["Debt repaid", change.debtRepaid, "Principal cleared"],
  ].filter(([, value]) => value !== 0) as [string, Paise, string][];

  return html`
    <section class="card">
      <h2>Since ${formatDate(change.from)}</h2>
      <p class="muted">${change.reading}</p>
      ${when(parts.length > 0, () => waterfall({
        title: "What moved net worth over the period",
        opening: 0 as Paise,
        openingLabel: "",
        includeOpening: false,
        steps: parts.map(([label, value]) => ({ label, value })),
        closingLabel: "Net change",
      }))}
      ${parts.map(
        ([label, value, blurb]) => html`
          <div class="row-between" style="padding:.5rem 0;border-top:1px solid var(--border)">
            <div>
              <strong>${label}</strong>
              <div class="faint">${blurb}</div>
            </div>
            <strong class="amount ${value < 0 ? "amount-negative" : "amount-positive"}">
              ${value > 0 ? "+" : ""}${formatPaise(value)}
            </strong>
          </div>
        `,
      )}
      <p class="field-hint">
        A net worth that rose because the rupee weakened is not the same
        achievement as one that rose because you repaid principal.
      </p>
    </section>
  `;
}

function renderGroup(group: NetWorthGroup): SafeHtml {
  return html`
    <details ${raw(group.lines.length <= 6 ? "open" : "")}>
      <summary style="min-height:44px;display:flex;align-items:center;cursor:pointer;gap:.75rem">
        <strong style="flex:1">${group.name}</strong>
        <span class="amount">${formatPaise(group.total)}</span>
      </summary>
      ${group.lines.map(
        (line) => html`
          <div class="row-between" style="padding:.4rem 0 .4rem 1rem;border-top:1px solid var(--border)">
            <span>
              <!--
                Every figure here comes from somewhere it can be changed — a
                register, a revaluation, a loan. A hand-valued asset said so
                and the rest did not, which left a fixed deposit or an "other
                asset" as a number with no way back to its own screen.
              -->
              ${line.href
                ? html`<a href="${line.href}">${line.label}</a>`
                : html`${line.label}`}
              ${when(line.stale, () => html`<span class="chip chip-warning">stale</span>`)}
              ${when(line.asOf, () => html`<span class="faint"> ${formatDate(line.asOf!)}</span>`)}
            </span>
            <span class="amount">${formatPaise(line.value)}</span>
          </div>
        `,
      )}
    </details>
  `;
}

function renderHistory(history: Snapshot[]): SafeHtml {
  const peak = Math.max(...history.map((h) => Math.abs(h.net_worth)), 1);
  const chrono = [...history].sort((a, b) => a.as_of.localeCompare(b.as_of)); // oldest → newest
  return html`
    <section class="card">
      <h2>Over time</h2>
      ${lineChart({
        title: "Net worth over time",
        xLabels: chrono.map((h) => formatDate(h.as_of).slice(3)),
        zeroBaseline: false,
        series: [{
          label: "Net worth",
          color: "var(--accent)",
          points: chrono.map((h) => h.net_worth / 100),
          fill: true,
        }],
      })}
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">As of</th>
              <th scope="col" class="num">Assets</th>
              <th scope="col" class="num">Liabilities</th>
              <th scope="col" class="num">Net worth</th>
              <th scope="col" style="width:35%"></th>
            </tr>
          </thead>
          <tbody>
            ${history.map(
              (h) => html`
                <tr>
                  <td>${formatDate(h.as_of)}</td>
                  <td class="num amount">
                    ${formatCompact(h.cash + h.investments + h.other_assets)}
                  </td>
                  <td class="num amount amount-negative">
                    ${formatCompact(h.credit_cards + h.loans)}
                  </td>
                  <td class="num amount"><strong>${formatCompact(h.net_worth)}</strong></td>
                  <td>
                    <span class="target-bar" style="max-width:100%;height:8px" aria-hidden="true">
                      <span style="width:${Math.round((Math.abs(h.net_worth) / peak) * 100)}%"></span>
                    </span>
                  </td>
                </tr>
              `,
            )}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

// ---------------------------------------------------------------------------
// S13b · Add a holding
// ---------------------------------------------------------------------------

export function renderAddHolding(opts: {
  assetAccounts: { id: string; name: string }[];
  budgetAccounts: { id: string; name: string }[];
  categories: { id: string; name: string }[];
  searchResults: { schemeCode: string; schemeName: string }[];
  query: string;
  today: IsoDate;
}): SafeHtml {
  return html`
    <h1>Add a holding</h1>

    <form method="get" action="/portfolio/add" class="card">
      <div class="field">
        <label for="q">Find a mutual fund</label>
        <input id="q" name="q" value="${opts.query}" placeholder="parag parikh flexi cap">
        <p class="field-hint">
          Searches AMFI's scheme list. <strong>Direct and Regular are different
          schemes with different NAVs</strong>, so pick the exact plan — the full
          name is shown for that reason.
        </p>
      </div>
      <button type="submit">Search</button>
    </form>

    ${when(opts.searchResults.length > 0, () => html`
      <section class="card">
        <h2>Pick the exact plan</h2>
        ${opts.searchResults.map(
          (r) => html`
            <form method="post" action="/portfolio/add" style="padding:.5rem 0;border-top:1px solid var(--border)">
              <input type="hidden" name="scheme_code" value="${r.schemeCode}">
              <input type="hidden" name="name" value="${r.schemeName}">
              <div class="row-between">
                <span>${r.schemeName} <span class="faint">${r.schemeCode}</span></span>
                <button class="button-small" type="submit" name="step" value="details">Choose</button>
              </div>
            </form>
          `,
        )}
      </section>
    `)}

    <section class="card">
      <h2>Or enter it by hand</h2>
      <form method="post" action="/portfolio/add">
        <input type="hidden" name="step" value="create">
        <div class="grid-2">
          <div class="field">
            <label for="name">Instrument</label>
            <input id="name" name="name" required placeholder="Parag Parikh Flexi Cap - Direct - Growth">
          </div>
          <div class="field">
            <label for="kind">Kind</label>
            <select id="kind" name="kind">
              <option value="mutual-fund">Mutual fund</option>
              <option value="equity">Equity</option>
              <option value="etf">ETF</option>
              <option value="commodity">Commodity</option>
              <option value="other">Other</option>
            </select>
          </div>
        </div>

        <div class="grid-2">
          <div class="field">
            <label for="account_id">Held in</label>
            <select id="account_id" name="account_id" required>
              ${opts.assetAccounts.map((a) => html`<option value="${a.id}">${a.name}</option>`)}
            </select>
          </div>
          <div class="field">
            <label for="currency">Currency</label>
            <select id="currency" name="currency">
              <option value="INR">₹ Indian rupee</option>
              <option value="USD">$ US dollar</option>
            </select>
          </div>
        </div>

        <fieldset>
          <legend>The purchase</legend>
          <div class="grid-2">
            <div class="field">
              <label for="amount">Amount invested</label>
              <input id="amount" name="amount" class="amount-input" type="text" inputmode="decimal">
              <p class="field-hint">Units are worked out from the price — how a SIP works.</p>
            </div>
            <div class="field">
              <label for="unit_price">Price per unit</label>
              <input id="unit_price" name="unit_price" type="text" inputmode="decimal" required>
            </div>
          </div>
          <div class="grid-2">
            <div class="field">
              <label for="trade_date">Bought on</label>
              <input id="trade_date" name="trade_date" value="${formatDate(opts.today)}">
            </div>
            <div class="field">
              <label for="fees">Fees and charges</label>
              <input id="fees" name="fees" class="amount-input" type="text" inputmode="decimal" placeholder="0.00">
              <p class="field-hint">Added to what the units cost you, by default.</p>
            </div>
          </div>
        </fieldset>

        <fieldset>
          <legend>Where the money came from</legend>
          <div class="grid-2">
            <div class="field">
              <label for="from_account_id">Paid from</label>
              <select id="from_account_id" name="from_account_id">
                <option value="">Don't record a payment</option>
                ${opts.budgetAccounts.map((a) => html`<option value="${a.id}">${a.name}</option>`)}
              </select>
            </div>
            <div class="field">
              <label for="category_id">Category</label>
              <select id="category_id" name="category_id">
                <option value="">None</option>
                ${opts.categories.map((c) => html`<option value="${c.id}">${c.name}</option>`)}
              </select>
            </div>
          </div>
          <p class="field-hint">
            Buying is money <strong>leaving</strong> the budget. Recording the category
            it came from keeps your envelope arithmetic whole, and stops reports
            counting an investment as spending.
          </p>
        </fieldset>

        <button class="button-primary" type="submit">Add it</button>
      </form>
    </section>
  `;
}

// ---------------------------------------------------------------------------
// `07` F19.14 · CAS import
// ---------------------------------------------------------------------------

/**
 * The upload form.
 *
 * PR5 is the thing to notice: the password field is `autocomplete="off"` and
 * the form never round-trips it. It is used to open one file and then it is
 * gone — there is no field on any record that could hold it.
 */
export function renderCasUpload(opts: {
  accounts: { id: string; name: string }[];
  error?: string | null;
}): SafeHtml {
  return html`
    <h1>Import a CAS</h1>
    <p class="muted">
      A CDSL Consolidated Account Statement covers every folio you hold, across
      every registrar. Import the PDF exactly as it arrived — it stays
      password-protected, and the password is used to open it and then
      forgotten.
    </p>

    ${when(opts.error, () => html`<p class="notice notice-error">${opts.error}</p>`)}

    ${opts.accounts.length === 0
      ? html`
          <div class="card empty-state">
            <p>There is no investment account to import into yet.</p>
            <p><a class="button" href="/accounts/new?kind=tracking">Add one</a></p>
          </div>
        `
      : html`
          <section class="card">
            <form method="post" action="/portfolio/cas" enctype="multipart/form-data">
              <div class="field">
                <label for="statement">The statement</label>
                <input id="statement" name="statement" type="file" accept="application/pdf,.pdf" required>
                <p class="field-hint">The PDF as the registrar sent it. Nothing is uploaded anywhere else.</p>
              </div>

              <div class="field">
                <label for="password">Its password</label>
                <input id="password" name="password" type="password"
                       autocomplete="off" spellcheck="false">
                <p class="field-hint">
                  Usually your PAN in capitals. Leave it empty if the file opens
                  without one. It is never saved.
                </p>
              </div>

              <div class="field">
                <label for="cas-account">Where new holdings go</label>
                <select id="cas-account" name="account_id" required>
                  ${opts.accounts.map((a) => html`<option value="${a.id}">${a.name}</option>`)}
                </select>
                <p class="field-hint">
                  Anything you already hold stays in the account it is already in.
                </p>
              </div>

              <button class="button-primary" type="submit">Read it</button>
              <a class="button button-quiet" href="/portfolio">Cancel</a>
            </form>
          </section>
        `}
  `;
}

export interface CasReviewRow {
  date: IsoDate;
  kind: string;
  description: string;
  amount: Paise;
  units: number;
  nav: number;
  status: "new" | "already-held" | "skipped";
  note: string | null;
}

export interface CasReviewScheme {
  index: number;
  name: string;
  folio: string;
  amc: string;
  isin: string | null;
  newInstrument: boolean;
  destination: string | null;
  rows: CasReviewRow[];
  newLots: number;
  invested: Paise;
  unitsDisagreement: number | null;
}

/**
 * What the statement would do, before it does anything (`04` I2).
 *
 * Every row is shown, including the ones already held — a review that hides
 * what it decided to ignore is asking to be trusted rather than checked.
 */
export function renderCasReview(opts: {
  period: { from: IsoDate; to: IsoDate } | null;
  schemes: CasReviewScheme[];
  unparsed: string[];
  totals: { newLots: number; alreadyHeld: number; invested: Paise };
  token: string;
}): SafeHtml {
  const statusChip = (status: CasReviewRow["status"]) =>
    status === "new"
      ? html`<span class="chip chip-positive">New</span>`
      : status === "already-held"
        ? html`<span class="chip">Already held</span>`
        : html`<span class="chip chip-warning">Skipped</span>`;

  return html`
    <h1>What this statement says</h1>
    <p class="muted">
      ${when(opts.period, () => html`
        Covering ${formatDate(opts.period!.from)} to ${formatDate(opts.period!.to)}.
      `)}
      Nothing is recorded until you confirm it below.
    </p>

    <section class="card">
      <div class="row-between">
        <div>
          <strong>${opts.totals.newLots}</strong>
          ${opts.totals.newLots === 1 ? "new entry" : "new entries"}
          ${when(opts.totals.alreadyHeld > 0, () => html`
            <span class="faint">
              · ${opts.totals.alreadyHeld} already recorded by an earlier statement
            </span>
          `)}
        </div>
        <div><strong>${formatPaise(opts.totals.invested)}</strong> invested</div>
      </div>
    </section>

    ${when(opts.unparsed.length > 0, () => html`
      <section class="card">
        <!-- IL3: never swallow a row that could not be read. -->
        <h2>Lines that did not parse <span class="chip chip-warning">${opts.unparsed.length}</span></h2>
        <p class="faint" style="margin-top:-.25rem">
          These looked like transactions but could not be read. Nothing was
          guessed from them — add anything that matters by hand.
        </p>
        <pre class="raw-block">${opts.unparsed.join("\n")}</pre>
      </section>
    `)}

    <form method="post" action="/portfolio/cas/confirm">
      <input type="hidden" name="token" value="${opts.token}">

      ${opts.schemes.map(
        (scheme) => html`
          <section class="card">
            <div class="row-between">
              <div>
                <strong>${scheme.name}</strong>
                ${when(scheme.newInstrument, () => html`<span class="chip chip-positive">New scheme</span>`)}
                <div class="faint">
                  ${scheme.amc} · Folio ${scheme.folio}
                  ${when(scheme.isin, () => html` · ISIN ${scheme.isin}`)}
                </div>
              </div>
              <label class="row">
                <input type="checkbox" name="scheme" value="${scheme.index}"
                       ${raw(scheme.newLots > 0 && scheme.unitsDisagreement === null ? "checked" : "")}>
                Import this one
              </label>
            </div>

            ${when(scheme.unitsDisagreement !== null, () => html`
              <!-- N9: a discrepancy is stated, never absorbed. -->
              <p class="notice notice-warning">
                This statement closes at a different number of units than its own
                rows add up to — off by
                ${formatUnits(Math.abs(scheme.unitsDisagreement!))}.
                A row is probably missing. Importing it would leave this holding
                disagreeing with your statement, so it is unticked by default.
              </p>
            `)}

            <div class="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Date</th>
                    <th scope="col">What</th>
                    <th scope="col" class="numeric">Amount</th>
                    <th scope="col" class="numeric">Units</th>
                    <th scope="col" class="numeric">NAV</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  ${scheme.rows.map(
                    (row) => html`
                      <tr class="${row.status === "new" ? "" : "faint"}">
                        <td>${formatDate(row.date)}</td>
                        <td>
                          ${row.description}
                          ${when(row.note, () => html`<div class="faint">${row.note}</div>`)}
                        </td>
                        <td class="numeric">${formatPaise(row.amount)}</td>
                        <td class="numeric">${formatUnits(row.units)}</td>
                        <td class="numeric">${formatPrice(row.nav)}</td>
                        <td>${statusChip(row.status)}</td>
                      </tr>
                    `,
                  )}
                </tbody>
              </table>
            </div>

            ${when(scheme.destination, () => html`
              <p class="field-hint">Lands in ${scheme.destination}.</p>
            `)}
          </section>
        `,
      )}

      <div class="card">
        <button class="button-primary" type="submit">
          Record ${opts.totals.newLots}
          ${opts.totals.newLots === 1 ? "entry" : "entries"}
        </button>
        <a class="button button-quiet" href="/portfolio">Discard this statement</a>
        <p class="field-hint">
          The whole import undoes in one action. The statement itself is not
          kept, and neither is its password.
        </p>
      </div>
    </form>
  `;
}

// ---------------------------------------------------------------------------
// F19.11 · Asset allocation
// ---------------------------------------------------------------------------

interface AllocSlice { key: string; label: string; value: Paise; share: number }

/**
 * The allocation report.
 *
 * The unclassified figure leads when it is non-zero, because a percentage that
 * silently omits a third of the portfolio is worse than one that says so (N9).
 * Each unclassified holding carries its own one-tap classifier.
 */
export function renderAllocation(opts: {
  byClass: AllocSlice[];
  byRegion: AllocSlice[];
  byCurrency: AllocSlice[];
  total: Paise;
  unclassified: { value: Paise; holdings: { instrumentId: string; name: string; value: Paise }[] };
  classes: { key: string; label: string }[];
  hasForeign: boolean;
}): SafeHtml {
  return html`
    <div class="row-between" style="margin-bottom:1rem">
      <h1>Allocation</h1>
      <a class="button" href="/portfolio">Back to portfolio</a>
    </div>

    ${when(opts.total === 0 && opts.unclassified.value === 0, () => html`
      <div class="card empty-state">
        <p>Nothing to allocate yet. Add a holding and it appears here.</p>
      </div>
    `)}

    ${when(opts.unclassified.value > 0, () => html`
      <section class="card">
        <h2>Not yet classified <span class="chip chip-warning">${formatPaise(opts.unclassified.value)}</span></h2>
        <p class="faint" style="margin-top:-.25rem">
          A mutual fund's type is not something the app can read from its name,
          so the percentages below leave these out until you set them. Nothing
          is guessed into a bucket.
        </p>
        ${opts.unclassified.holdings.map(
          (h) => html`
            <form method="post" action="/portfolio/instrument/${h.instrumentId}/classify"
                  class="row-between" style="padding:.5rem 0;border-top:1px solid var(--border);gap:.6rem;flex-wrap:wrap">
              <span><strong>${h.name}</strong> <span class="faint">${formatPaise(h.value)}</span></span>
              <span class="row" style="gap:.4rem">
                <label class="sr-only" for="class-${h.instrumentId}">
                  What kind of thing is ${h.name}?
                </label>
                <select id="class-${h.instrumentId}" name="asset_class" required>
                  <option value="">Classify as…</option>
                  ${opts.classes.map((c) => html`<option value="${c.key}">${c.label}</option>`)}
                </select>
                <button class="button-small button-primary" type="submit">Set</button>
              </span>
            </form>
          `,
        )}
      </section>
    `)}

    ${when(opts.total > 0, () => html`
      <section class="card">
        <h2>By class</h2>
        ${donutChart({
          title: "Portfolio allocation by asset class",
          slices: opts.byClass.map((s) => ({ label: s.label, value: s.value })),
          centerLabel: formatCompact(opts.total),
          centerSub: "classified",
        })}
        <p class="field-hint">Percentages are of ${formatPaise(opts.total)} classified.</p>
      </section>

      ${when(opts.hasForeign, () => html`
        <section class="card">
          <h2>By geography</h2>
          ${donutChart({
            title: "Portfolio allocation by geography",
            slices: opts.byRegion.map((s) => ({ label: s.label, value: s.value })),
          })}
        </section>

        <section class="card">
          <h2>By currency</h2>
          ${donutChart({
            title: "Portfolio allocation by currency",
            slices: opts.byCurrency.map((s) => ({ label: s.label, value: s.value })),
          })}
        </section>
      `)}
    `)}
  `;
}
