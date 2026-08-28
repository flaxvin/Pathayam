/**
 * S16 · Overview — the one screen that answers "where do I stand?"
 *
 * Nothing here is new data; it is the five numbers a household checks most,
 * gathered from the budget, the cashflow projection, net worth and the insight
 * engine, each linking to the screen that owns it. The budget grid stays the
 * home for *doing*; this is the home for *seeing*.
 */

import { html, raw, when, type SafeHtml } from "../../http/html.ts";
import { formatPaise, formatCompact, type Paise } from "../../core/money.ts";
import { formatDate, formatMonth, type MonthKey } from "../../core/dates.ts";
import type { Cashflow, CalendarDay } from "../../domain/schedules.ts";
import type { Snapshot } from "../../domain/networth.ts";
import type { Insight } from "../../domain/insights.ts";
import { lineChart } from "../charts.ts";

export function renderOverview(opts: {
  month: MonthKey;
  rta: Paise;
  rtaState: string;
  netWorth: Paise;
  netWorthHistory: Snapshot[];
  cashflow: Cashflow;
  cashflowReading: string;
  upcoming: CalendarDay[];
  unfundedCards: { name: string; amount: Paise }[];
  insights: Insight[];
  monthSpend: Paise;
}): SafeHtml {
  const chrono = [...opts.netWorthHistory].sort((a, b) => a.as_of.localeCompare(b.as_of));

  return html`
    <div class="row-between" style="margin-bottom:1rem">
      <h1>Overview</h1>
      <span class="faint">${formatMonth(opts.month)}</span>
    </div>

    <div class="overview-grid">
      <!-- Ready to Assign -->
      <section class="card overview-tile">
        <div class="overview-label">Ready to assign</div>
        <div class="overview-figure rta-${opts.rtaState}">${formatPaise(opts.rta)}</div>
        <a class="faint" href="/">Open the budget →</a>
      </section>

      <!-- Net worth -->
      <section class="card overview-tile">
        <div class="overview-label">Net worth</div>
        <div class="overview-figure ${opts.netWorth < 0 ? "amount-negative" : ""}">
          ${formatPaise(opts.netWorth)}
        </div>
        <a class="faint" href="/net-worth">Net-worth statement →</a>
      </section>

      <!-- This month's spend -->
      <section class="card overview-tile">
        <div class="overview-label">Spent this month</div>
        <div class="overview-figure">${formatPaise(opts.monthSpend)}</div>
        <a class="faint" href="/reports">Reports →</a>
      </section>
    </div>

    <!-- Will you make it? -->
    <section class="card">
      <div class="row-between">
        <h2>Will you make it?</h2>
        <a class="button button-small" href="/schedules">Cashflow</a>
      </div>
      <p class="${opts.cashflow.firstShortfall ? "notice notice-warning" : "notice notice-success"}">
        ${opts.cashflowReading}
      </p>
      ${when(opts.cashflow.days.length >= 2, () => lineChart({
        title: "Projected balance over the window",
        xLabels: ["now", ...opts.cashflow.days.map((d) => formatDate(d.date).slice(0, 5))],
        series: [{
          label: "Projected balance",
          color: opts.cashflow.firstShortfall ? "var(--danger)" : "var(--accent)",
          points: [opts.cashflow.openingBalance / 100, ...opts.cashflow.days.map((d) => d.projectedBalance / 100)],
          fill: true,
        }],
      }))}
    </section>

    <div class="overview-grid-2">
      <!-- Upcoming bills -->
      <section class="card">
        <h2>Next up</h2>
        ${opts.upcoming.length === 0
          ? html`<p class="faint">Nothing scheduled in the days ahead.</p>`
          : html`
              <ul class="overview-list">
                ${opts.upcoming.map((d) => html`
                  <li>
                    <span class="overview-date">${formatDate(d.date).slice(0, 5)}</span>
                    <span class="overview-items">
                      ${d.outflows.map((o) => o.label).concat(d.inflows.map((i) => i.label)).join(", ")}
                    </span>
                    <span class="amount ${dayNet(d) < 0 ? "amount-negative" : "amount-positive"}">
                      ${formatCompact(dayNet(d))}
                    </span>
                  </li>
                `)}
              </ul>
            `}
      </section>

      <!-- Attention: unfunded cards + insights -->
      <section class="card">
        <h2>Worth noticing</h2>
        ${when(opts.unfundedCards.length > 0, () => html`
          ${opts.unfundedCards.map((c) => html`
            <p class="notice notice-warning" style="margin:.35rem 0">
              ${c.name} has <strong>${formatPaise(c.amount)}</strong> of its balance unfunded.
              <a href="/accounts">Fund it</a>
            </p>
          `)}
        `)}
        ${when(opts.insights.length > 0, () => html`
          <ul class="overview-list">
            ${opts.insights.slice(0, 4).map((i) => html`<li><span>${i.text}</span></li>`)}
          </ul>
        `)}
        ${when(opts.unfundedCards.length === 0 && opts.insights.length === 0, () => html`
          <p class="faint">Nothing standing out. Every card is funded and spending is steady.</p>
        `)}
      </section>
    </div>

    ${when(chrono.length > 1, () => html`
      <section class="card">
        <h2>Net worth over time</h2>
        ${lineChart({
          title: "Net worth over time",
          xLabels: chrono.map((h) => formatDate(h.as_of).slice(3)),
          zeroBaseline: false,
          series: [{ label: "Net worth", color: "var(--accent)", points: chrono.map((h) => h.net_worth / 100), fill: true }],
        })}
      </section>
    `)}
  `;
}

function dayNet(d: CalendarDay): Paise {
  const inflow = d.inflows.reduce((s, i) => s + i.amount, 0);
  const outflow = d.outflows.reduce((s, o) => s + o.amount, 0);
  return (inflow - outflow) as Paise;
}
