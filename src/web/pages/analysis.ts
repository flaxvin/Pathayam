/**
 * S6 · Reports · S7 · Query · S8 · Schedules and the cashflow calendar ·
 * S9 · Goals · Search.
 *
 * The query screen (S7) is the one that matters: F10.3 replaces a
 * proliferation of report presets with a single filterable, groupable table,
 * and the "reports" are saved filters over it. Everything drills back to the
 * transactions behind it (F10.2), so no figure is a dead end.
 */

import { html, raw, when, type SafeHtml } from "../../http/html.ts";
import type { GainsYear } from "../../domain/reports.ts";
import { formatPaise, formatCompact, type Paise } from "../../core/money.ts";
import { formatDate, formatMonth, type IsoDate, type MonthKey } from "../../core/dates.ts";
import { renderScopeSwitch } from "../scope-switch.ts";
import type { QueryRow, GroupedTotal, GroupBy, Period, TrendPoint } from "../../domain/reports.ts";
import type { Schedule, DetectedSchedule, Cashflow, CalendarDay } from "../../domain/schedules.ts";
import type { GoalProgress } from "../../domain/goals.ts";
import {
  groupedBarChart, lineChart, progressRing, horizontalBars, donutChart, sparkline,
  heatmapCalendar, treemap, sankeyBudget,
} from "../charts.ts";
import type { Insight, InsightKind } from "../../domain/insights.ts";

// ---------------------------------------------------------------------------
// S7 · Query
// ---------------------------------------------------------------------------

/**
 * B96 · How many rows the table itself draws.
 *
 * Named so it can be said out loud on the page. It was an unexplained
 * `.slice(0, 300)` in the middle of the markup, which is how a screen ends up
 * quietly answering a different question from the one it was asked.
 */
const QUERY_TABLE_ROWS = 300;

export interface QueryOptions {
  rows: QueryRow[];
  /** B96 · How many rows the filter matched, of which `rows` is one page. */
  matched: number;
  /** B96 · Summed over everything that matched, not just the rendered page. */
  totals: { net: Paise; outflow: Paise; inflow: Paise };
  /** The current filter as a query string, so the CSV link keeps it. */
  csvQuery?: string;
  groups: GroupedTotal[];
  groupBy: GroupBy;
  period: Period;
  periods: Period[];
  text: string;
  accounts: { id: string; name: string }[];
  categories: { id: string; name: string }[];
  /**
   * 15 · The scopes this question could be asked at. Empty for a household with
   * one budget, which has only ever had one answer.
   */
  budgets?: { id: string; name: string; kind: string }[];
  scope?: string;
  selectedAccounts: string[];
  selectedCategories: string[];
  title?: string;
}

export function renderQuery(opts: QueryOptions): SafeHtml {
  // B96 · Over everything the filter matched. `rows` is only what is rendered.
  const { net: total, outflow, inflow } = opts.totals;

  return html`
    <div class="row-between" style="margin-bottom:1rem">
      <h1>${opts.title ?? "Query"}</h1>
      <a class="button button-small" href="/query.csv${filterQueryString(opts)}">Export CSV</a>
    </div>

    ${when((opts.budgets ?? []).length > 1, () => html`
      <!--
        16 · This screen offers every scope rather than picking one. "What did we
        spend on groceries", "what did I spend" and "what did all of it come to"
        are three questions, and answering only one of them silently would be
        wrong twice as often as it was right.
      -->
      <div class="row" style="align-items:center;gap:.5rem;margin-bottom:.75rem;flex-wrap:wrap">
        <span class="faint">Whose money</span>
        ${renderScopeSwitch({
          budgets: opts.budgets ?? [],
          current: opts.scope ?? "all",
          href: (scope) => `/query${filterQueryString(opts, scope)}`,
          everything: true,
          label: "Whose money",
        })}
      </div>
    `)}

    <form method="get" action="/query" class="card">
      <div class="grid-2">
        <div class="field">
          <label for="period">Period</label>
          <select id="period" name="period">
            ${opts.periods.map(
              (p) => html`
                <option value="${p.key}" ${raw(p.key === opts.period.key ? "selected" : "")}>
                  ${p.label}
                </option>
              `,
            )}
          </select>
        </div>
        <!--
          N6 · Scope is above the form, in the same pills the header uses, rather
          than a dropdown among the filters. It stays part of the filter all the
          same: each pill carries the current query, so changing whose money you
          are looking at does not throw away what you were asking.
        -->
        <input type="hidden" name="scope" value="${opts.scope ?? "all"}">
        <div class="field">
          <label for="group_by">Group by</label>
          <select id="group_by" name="group_by">
            ${(["category", "payee", "account", "owner", "month"] as GroupBy[]).map(
              (g) => html`
                <option value="${g}" ${raw(g === opts.groupBy ? "selected" : "")}>
                  ${g === "owner" ? "Who spent it" : g}
                </option>
              `,
            )}
          </select>
        </div>
      </div>

      <div class="grid-2">
        <div class="field">
          <label for="q">Search</label>
          <input id="q" name="q" value="${opts.text}"
                 placeholder="Payee, memo, category, tag, or the bank's own string">
          <p class="field-hint">
            Searches the raw imported narration too, so you can find something by
            what the bank called it.
          </p>
        </div>
        <div class="field">
          <label for="account">Account</label>
          <select id="account" name="account">
            <option value="">All accounts</option>
            ${opts.accounts.map(
              (a) => html`
                <option value="${a.id}" ${raw(opts.selectedAccounts.includes(a.id) ? "selected" : "")}>
                  ${a.name}
                </option>
              `,
            )}
          </select>
        </div>
      </div>

      <button type="submit">Apply</button>
      <a class="button button-quiet" href="/query">Clear</a>
    </form>

    <div class="card">
      <div class="row" style="gap:2rem;flex-wrap:wrap">
        <div>
          <div class="faint">Out</div>
          <strong class="amount amount-negative" style="font-size:1.15rem">${formatPaise(outflow)}</strong>
        </div>
        <div>
          <div class="faint">In</div>
          <strong class="amount amount-positive" style="font-size:1.15rem">${formatPaise(inflow)}</strong>
        </div>
        <div>
          <div class="faint">Net</div>
          <strong class="amount" style="font-size:1.15rem">${formatPaise(total)}</strong>
        </div>
        <div>
          <div class="faint">Rows</div>
          <strong style="font-size:1.15rem">${opts.matched}</strong>
        </div>
      </div>
      <p class="field-hint">
        ${formatDate(opts.period.from)} to ${formatDate(opts.period.to)}
      </p>
      <!--
        B96 · Say so when the table is a page of the answer rather than all of
        it. The figures above and the groups below are over everything that
        matched; only this list is cut, and a list that is quietly cut on a
        screen called Query is how a household comes to trust a wrong total.
      -->
      ${when(opts.matched > QUERY_TABLE_ROWS, () => html`
        <p class="notice notice-info">
          The table below lists the ${QUERY_TABLE_ROWS} most recent of ${opts.matched}.
          Every figure on this page counts all ${opts.matched} —
          <a href="/query.csv${opts.csvQuery ?? ""}">export the CSV</a> for the rest.
        </p>
      `)}
    </div>

    ${when(opts.groups.length > 0, () => html`
      <section class="card">
        <h2>By ${opts.groupBy === "owner" ? "who spent it" : opts.groupBy}</h2>
        ${opts.groups.map((g) => renderGroupRow(g, opts))}
      </section>
    `)}

    <section class="card">
      <h2>Transactions</h2>
      ${opts.rows.length === 0
        ? html`<p class="faint">Nothing matches those filters.</p>`
        : html`
            <div class="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Date</th>
                    <th scope="col">Payee</th>
                    <th scope="col">Category</th>
                    <th scope="col">Account</th>
                    <!-- H2 · Who spent it, in the table rather than only in a
                         grouping. On a shared account it is half the answer to
                         "what was this?" and it was one click away. -->
                    <th scope="col">Who</th>
                    <th scope="col" class="num">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  ${opts.rows.slice(0, QUERY_TABLE_ROWS).map(
                    (r) => html`
                      <tr>
                        <td>${formatDate(r.date)}</td>
                        <td><a href="/transaction/${r.id}">${r.payee ?? "—"}</a></td>
                        <td>
                          ${r.category ?? html`<span class="chip chip-warning">Uncategorised</span>`}
                        </td>
                        <td class="faint">${r.account}</td>
                        <td class="faint">${r.owner ?? "—"}</td>
                        <td class="num amount ${r.amount < 0 ? "amount-negative" : "amount-positive"}">
                          ${formatPaise(r.amount)}
                        </td>
                      </tr>
                    `,
                  )}
                </tbody>
              </table>
            </div>
          `}
    </section>
  `;
}

/** F10.2 · Every figure drills down to the transactions behind it. */
function renderGroupRow(group: GroupedTotal, opts: QueryOptions): SafeHtml {
  const largest = Math.max(...opts.groups.map((g) => Math.abs(g.total)), 1);
  const width = Math.round((Math.abs(group.total) / largest) * 100);
  const drill =
    opts.groupBy === "category" && group.key !== "none"
      ? `/query?period=${opts.period.key}&category=${encodeURIComponent(group.key)}`
      : null;

  return html`
    <div style="padding:.5rem 0;border-top:1px solid var(--border)">
      <div class="row-between">
        <span>${drill ? html`<a href="${drill}">${group.label}</a>` : group.label}</span>
        <span class="amount ${group.total < 0 ? "amount-negative" : ""}">
          ${formatPaise(group.total)}
          <span class="faint">${group.count}</span>
        </span>
      </div>
      <span class="target-bar" style="max-width:100%;margin-top:.25rem" role="img"
            aria-label="${formatPaise(Math.abs(group.total))}">
        <span style="width:${width}%;background:${group.total < 0 ? "var(--danger)" : "var(--positive)"}"></span>
      </span>
    </div>
  `;
}

/**
 * The current question as a query string, so a link can carry it: the CSV
 * export, and each pill of the scope switch.
 *
 * `scope` can be overridden, which is what makes the switch a switch — every
 * other part of the filter travels with it rather than being thrown away.
 */
function filterQueryString(opts: QueryOptions, scope = opts.scope): string {
  const params = new URLSearchParams({ period: opts.period.key, group_by: opts.groupBy });
  if (opts.text) params.set("q", opts.text);
  if (scope && scope !== "all") params.set("scope", scope);
  /*
   * These were missing, so "Export CSV" answered a different question from the
   * screen it sat on: filter to one account, export, and the file had every
   * account in it.
   */
  if (opts.selectedAccounts[0]) params.set("account", opts.selectedAccounts[0]);
  if (opts.selectedCategories[0]) params.set("category", opts.selectedCategories[0]);
  return `?${params}`;
}

// ---------------------------------------------------------------------------
// S6 · Reports
// ---------------------------------------------------------------------------

function insightMark(kind: InsightKind): string {
  return kind === "up" ? "▲" : kind === "down" ? "▼" : kind === "new" ? "＋" : "·";
}

export function renderReports(opts: {
  insights: Insight[];
  trend: TrendPoint[];
  categorySpend: { label: string; value: Paise }[];
  categoryTrends: { name: string; spent: number[] }[];
  tagSpend: { tag: string; spent: Paise; budget: Paise | null }[];
  spendingCalendar: { date: IsoDate; value: Paise }[];
  sankey: { income: Paise; month: MonthKey; groups: { name: string; categories: { name: string; value: Paise }[] }[] };
  period: Period;
  periods: Period[];
  loanInterest: { fy: number; label: string; interest: Paise; principal: Paise; lender: string }[];
  /** B88 · Realised gains per FY, split by holding period. */
  gains: GainsYear[];
  /** 15 / 16 · Reports offer every scope rather than picking one. */
  budgets?: { id: string; name: string; kind: string }[];
  scope?: string;
}): SafeHtml {
  const peak = Math.max(...opts.trend.flatMap((t) => [t.income, t.spending]), 1);
  // Top categories individually; the long tail folded into one "Other" slice so
  // the donut stays legible rather than becoming a colour wheel.
  const TOP = 7;
  const catSlices = opts.categorySpend.slice(0, TOP).map((c) => ({ label: c.label, value: c.value }));
  const tail = opts.categorySpend.slice(TOP).reduce((s, c) => s + c.value, 0);
  if (tail > 0) catSlices.push({ label: `Other (${opts.categorySpend.length - TOP})`, value: tail as Paise });

  return html`
    <h1>Reports</h1>
    <p class="muted">
      Each of these is the query screen with a filter already applied — open any of
      them and you can change it.
    </p>

    ${when((opts.budgets ?? []).length > 1, () => html`
      <!--
        N6 · The same control the header carries, with one extra pill. It was a
        dropdown in a card in different words — "The household's" where the
        header says "Household" — which is two controls for one question, and
        somebody who learned one did not find the other. It also submitted
        itself with a script, so it did nothing at all without one.
      -->
      <section class="card">
        <div class="faint" style="margin-bottom:.4rem">Whose money these are about</div>
        ${renderScopeSwitch({
          budgets: opts.budgets ?? [],
          current: opts.scope ?? "all",
          href: (scope) =>
            `/reports?period=${encodeURIComponent(opts.period.key)}`
            + (scope === "all" ? "" : `&scope=${encodeURIComponent(scope)}`),
          everything: true,
          label: "Whose money these are about",
        })}
      </section>
    `)}

    ${when(opts.insights.length > 0, () => html`
      <section class="card">
        <h2>Worth noticing</h2>
        <p class="faint" style="margin-top:-.25rem">
          This month against the three before it. Plain observations — the app draws
          no conclusions.
        </p>
        <ul class="insight-list">
          ${opts.insights.map((i) => html`
            <li class="insight insight-${i.kind}">
              <span class="insight-mark" aria-hidden="true">${insightMark(i.kind)}</span>
              <span>
                ${i.text}
                ${when(i.categoryId !== "", () => html`
                  <a class="faint" href="/query?category=${i.categoryId}&period=this-month">see it</a>
                `)}
              </span>
            </li>
          `)}
        </ul>
      </section>
    `)}

    <section class="card">
      <h2>Income and spending</h2>
      ${opts.trend.length === 0
        ? html`<p class="faint">Not enough history yet.</p>`
        : html`
            ${groupedBarChart({
              title: "Income and spending, month by month",
              groups: opts.trend.map((t) => ({
                label: formatMonth(t.month).slice(0, 3),
                values: [t.income, t.spending],
              })),
              series: [
                { label: "In", color: "var(--positive)" },
                { label: "Out", color: "var(--danger)" },
              ],
            })}
            ${lineChart({
              title: "Net saved each month",
              xLabels: opts.trend.map((t) => formatMonth(t.month).slice(0, 3)),
              series: [{
                label: "Net", color: "var(--accent)", fill: true,
                points: opts.trend.map((t) => t.net / 100),
              }],
            })}
            <div class="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Month</th>
                    <th scope="col" class="num">In</th>
                    <th scope="col" class="num">Out</th>
                    <th scope="col" class="num">Net</th>
                    <th scope="col" style="width:40%"></th>
                  </tr>
                </thead>
                <tbody>
                  ${opts.trend.map(
                    (t) => html`
                      <tr>
                        <td>${formatMonth(t.month)}</td>
                        <td class="num amount amount-positive">${formatCompact(t.income)}</td>
                        <td class="num amount amount-negative">${formatCompact(t.spending)}</td>
                        <td class="num amount ${t.net < 0 ? "amount-negative" : ""}">
                          ${formatCompact(t.net)}
                        </td>
                        <td>
                          <!-- A2: the bars are paired with the figures beside them,
                               never the only way to read the row. -->
                          <span class="target-bar" style="max-width:100%;height:8px" aria-hidden="true">
                            <span style="width:${Math.round((t.income / peak) * 100)}%"></span>
                          </span>
                          <span class="target-bar" style="max-width:100%;height:8px;margin-top:2px" aria-hidden="true">
                            <span style="width:${Math.round((t.spending / peak) * 100)}%;background:var(--danger)"></span>
                          </span>
                        </td>
                      </tr>
                    `,
                  )}
                </tbody>
              </table>
            </div>
          `}
    </section>

    ${when(catSlices.length > 0, () => html`
      <section class="card">
        <h2>Spending by category</h2>
        <p class="faint" style="margin-top:-.25rem">Over ${opts.period.label.toLowerCase()}.</p>
        ${donutChart({
          title: "Spending by category over the period",
          slices: catSlices,
        })}
      </section>
    `)}

    ${when(opts.categorySpend.length > 2, () => html`
      <section class="card">
        <h2>Spending map</h2>
        <p class="faint" style="margin-top:-.25rem">
          Every category sized by what it took, ${opts.period.label.toLowerCase()}.
        </p>
        ${treemap({
          title: "Spending by category as a treemap",
          items: opts.categorySpend.map((c) => ({ label: c.label, value: c.value })),
        })}
      </section>
    `)}

    ${when(opts.tagSpend.length > 0, () => html`
      <section class="card">
        <h2>By tag</h2>
        <p class="faint" style="margin-top:-.25rem">
          Tags work as ad-hoc budgets — here's what each took, ${opts.period.label.toLowerCase()}.
        </p>
        ${horizontalBars({
          title: "Spending by tag",
          items: opts.tagSpend.map((t) => ({ label: t.tag, value: t.spent })),
        })}
        ${when(opts.tagSpend.some((t) => t.budget !== null), () => html`
          <div class="table-scroll">
            <table style="margin-top:.5rem">
              <tbody>
                ${opts.tagSpend.filter((t) => t.budget !== null).map((t) => html`
                  <tr>
                    <td>${t.tag}</td>
                    <td class="num">${formatPaise(t.spent)} of ${formatPaise(t.budget!)}</td>
                    <td class="num ${t.spent > t.budget! ? "amount-negative" : "amount-positive"}">
                      ${t.spent > t.budget! ? "over by " : ""}${formatPaise(Math.abs(t.budget! - t.spent) as Paise)}
                      ${t.spent > t.budget! ? "" : " left"}
                    </td>
                  </tr>
                `)}
              </tbody>
            </table>
          </div>
        `)}
      </section>
    `)}

    ${when(opts.spendingCalendar.some((d) => d.value > 0), () => html`
      <section class="card">
        <h2>Spending calendar</h2>
        <p class="faint" style="margin-top:-.25rem">
          Each day over the last ~17 weeks, shaded by what was spent.
        </p>
        ${heatmapCalendar({ title: "Daily spending heatmap", days: opts.spendingCalendar })}
      </section>
    `)}

    ${when(opts.sankey.income > 0 && opts.sankey.groups.length > 0, () => html`
      <section class="card">
        <h2>Where your money went</h2>
        <p class="faint" style="margin-top:-.25rem">
          ${formatMonth(opts.sankey.month)}: income in, and where it flowed by group and category.
        </p>
        ${sankeyBudget({
          title: "Income to spending flow for the month",
          income: opts.sankey.income,
          groups: opts.sankey.groups,
        })}
      </section>
    `)}

    ${when(opts.categoryTrends.some((t) => t.spent.some((v) => v > 0)), () => html`
      <section class="card">
        <h2>Category trends</h2>
        <p class="faint" style="margin-top:-.25rem">Each category's spend over the last 12 months.</p>
        <div class="sparkline-grid">
          ${opts.categoryTrends.map((t) => html`
            <div class="sparkline-cell">
              <span class="sparkline-name">${t.name}</span>
              ${sparkline({ points: t.spent, width: 110, height: 30, title: `${t.name} — 12-month spend` })}
            </div>
          `)}
        </div>
      </section>
    `)}

    <section class="card">
      <h2>Where the money goes</h2>
      <div class="row" style="flex-wrap:wrap">
        <a class="button" href="/query?group_by=category&period=${opts.period.key}">By category</a>
        <a class="button" href="/query?group_by=payee&period=${opts.period.key}">By payee</a>
        <a class="button" href="/query?group_by=owner&period=${opts.period.key}">By who spent it</a>
        <a class="button" href="/query?group_by=account&period=${opts.period.key}">By account</a>
        <a class="button" href="/query?group_by=month&period=last-12">Month by month</a>
      </div>
    </section>

    ${when(opts.loanInterest.length > 0, () => html`
      <section class="card">
        <h2>Loan interest by financial year</h2>
        <p class="faint" style="margin-top:-.25rem">
          April to March, for your own records. This states what was paid and
          nothing more. The <a href="/tax">tax estimate</a> is a separate screen,
          it is an estimate rather than a computation of what you owe, and it
          does not read this figure — enter it there yourself if you claim it.
        </p>
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Year</th>
                <th scope="col">Lender</th>
                <th scope="col" class="num">Interest</th>
                <th scope="col" class="num">Principal</th>
              </tr>
            </thead>
            <tbody>
              ${opts.loanInterest.map(
                (r) => html`
                  <tr>
                    <td>${r.label}</td>
                    <td>${r.lender}</td>
                    <td class="num amount">${formatPaise(r.interest)}</td>
                    <td class="num amount">${formatPaise(r.principal)}</td>
                  </tr>
                `,
              )}
            </tbody>
          </table>
        </div>
      </section>
    `)}

    ${when(opts.gains.length > 0, () => html`
      <section class="card">
        <h2>Realised gains by financial year</h2>
        <p class="faint" style="margin-top:-.25rem">
          What each sale actually made, April to March. Split at twelve months
          held — which threshold makes a gain long-term depends on the asset and
          on the year's rules, so this reports the holding period and leaves the
          rule to whoever files the return.
        </p>
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Year</th>
                <th scope="col" class="num">Held 12 months or less</th>
                <th scope="col" class="num">Held longer</th>
                <th scope="col" class="num">Proceeds</th>
              </tr>
            </thead>
            <tbody>
              ${opts.gains.map(
                (y) => html`
                  <tr>
                    <td>${y.label}</td>
                    <td class="num amount ${y.shortTerm < 0 ? "amount-negative" : ""}">
                      ${formatPaise(y.shortTerm)}
                    </td>
                    <td class="num amount ${y.longTerm < 0 ? "amount-negative" : ""}">
                      ${formatPaise(y.longTerm)}
                    </td>
                    <td class="num amount">${formatPaise(y.proceeds)}</td>
                  </tr>
                  ${when(y.unknownPeriod !== 0, () => html`
                    <tr>
                      <td colspan="4" class="faint">
                        ${formatPaise(y.unknownPeriod)} of this year's gain was recorded
                        before parcel detail was kept, so its holding period is unknown.
                        Check those sales against your broker statement.
                      </td>
                    </tr>
                  `)}
                `,
              )}
            </tbody>
          </table>
        </div>

        ${when(opts.gains.some((y) => y.parcels.length > 0), () => html`
          <details style="margin-top:.75rem">
            <summary class="linkish">Every parcel sold</summary>
            <div class="table-scroll" style="margin-top:.5rem">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Sold</th>
                    <th scope="col">Holding</th>
                    <th scope="col">Bought</th>
                    <th scope="col" class="num">Held</th>
                    <th scope="col" class="num">Cost</th>
                    <th scope="col" class="num">Proceeds</th>
                    <th scope="col" class="num">Gain</th>
                  </tr>
                </thead>
                <tbody>
                  ${opts.gains.flatMap((y) => y.parcels).map(
                    (p) => html`
                      <tr>
                        <td>${formatDate(p.soldOn)}</td>
                        <td>${p.instrument}</td>
                        <td>${formatDate(p.acquiredOn)}</td>
                        <td class="num">
                          ${p.holdingPeriodDays} days
                          ${when(p.longTerm, () => html`<span class="chip">over a year</span>`)}
                        </td>
                        <td class="num amount">${formatPaise(p.cost)}</td>
                        <td class="num amount">${formatPaise(p.proceeds)}</td>
                        <td class="num amount ${p.gain < 0 ? "amount-negative" : ""}">
                          ${formatPaise(p.gain)}
                        </td>
                      </tr>
                    `,
                  )}
                </tbody>
              </table>
            </div>
          </details>
        `)}
      </section>
    `)}
  `;
}

// ---------------------------------------------------------------------------
// S8 · Schedules and the cashflow calendar
// ---------------------------------------------------------------------------

export function renderSchedules(opts: {
  schedules: Schedule[];
  detected: DetectedSchedule[];
  cashflow: Cashflow;
  cashflowReading: string;
  subscriptions: { schedule: Schedule; annualised: Paise }[];
  horizon: number;
  categoryNames: Map<string, string>;
  /**
   * The full lists, for the inline edit form. Without them it showed neither the
   * account nor the envelope — and the route reads both, so saving would have
   * blanked whatever the form did not carry.
   */
  categories?: { id: string; name: string }[];
  accounts?: { id: string; name: string }[];
  /**
   * The envelopes each schedule divides into, by schedule id.
   *
   * A salary is provident fund, tax deducted and what landed; rent is rent plus
   * maintenance. Both are one payment on one date and both used to be split by
   * hand every month, which is the work a schedule exists to remove.
   */
  splits?: Map<string, { category_id: string | null; amount: Paise }[]>;
}): SafeHtml {
  return html`
    <h1>Schedules &amp; cashflow</h1>

    <section class="card">
      <h2>Will you make it?</h2>
      <!-- F7.7: the question envelopes cannot answer on their own. -->
      <p class="${opts.cashflow.firstShortfall ? "notice notice-warning" : "notice notice-success"}">
        ${opts.cashflowReading}
      </p>
      <div class="row" style="flex-wrap:wrap">
        ${[30, 60, 90, 365].map(
          (d) => html`
            <a class="button button-small ${d === opts.horizon ? "button-primary" : ""}"
               href="/schedules?days=${d}">${d} days</a>
          `,
        )}
      </div>
    </section>

    <section class="card">
      <h2>The next ${opts.horizon} days</h2>
      ${cashflowChart(opts.cashflow)}
      ${renderCalendar(opts.cashflow)}
    </section>

    <section class="card">
      <div class="row-between">
        <h2>Schedules</h2>
        <a class="button button-small" href="/schedules/new">Add one</a>
      </div>
      ${opts.schedules.length === 0
        ? html`<p class="faint">Nothing scheduled yet.</p>`
        : opts.schedules.map(
            (s) => html`
              <div style="padding:.6rem 0;border-top:1px solid var(--border)">
                <div class="row-between">
                  <div>
                    <strong>${s.name}</strong>
                    ${when((s.amount ?? 0) > 0, () => html`
                      <span class="chip chip-positive">coming in</span>
                    `)}
                    ${when(s.detected === 1, () => html`
                      <!-- F7.8: detected is never presented as confirmed. -->
                      <span class="chip chip-warning">detected — ${s.confidence} confidence</span>
                    `)}
                    <div class="faint">
                      ${s.recurrence}${s.next_due ? ` · next ${formatDate(s.next_due)}` : ""}
                      ${s.category_id ? ` · ${opts.categoryNames.get(s.category_id) ?? ""}` : ""}
                    </div>
                  </div>
                  <div class="row">
                    <span class="amount ${(s.amount ?? 0) > 0 ? "amount-positive" : ""}">
                      ${s.amount !== null ? formatPaise(Math.abs(s.amount)) : "—"}
                    </span>
                    <form method="post" action="/schedules/${s.id}/paid">
                      <button class="button-small" type="submit">
                        ${(s.amount ?? 0) > 0 ? "Arrived" : "Paid"}
                      </button>
                    </form>
                    <form method="post" action="/schedules/${s.id}/skip">
                      <button class="button-small button-quiet" type="submit">Skip</button>
                    </form>
                  </div>
                </div>

                <!--
                  A schedule was permanent once created — no edit, no delete. A
                  typo in the amount or a cancelled subscription stayed in the
                  cashflow projection for good.
                -->
                <details style="margin-top:.4rem">
                  <summary class="linkish" style="font-size:.85rem">Edit or remove</summary>
                  <form method="post" action="/schedules/${s.id}/edit"
                        class="row" style="gap:.4rem;align-items:flex-end;flex-wrap:wrap;margin-top:.5rem">
                    <div class="field" style="margin:0">
                      <label style="font-size:.75rem" for="sn-${s.id}">Name</label>
                      <input id="sn-${s.id}" name="name" value="${s.name}" style="max-width:12rem">
                    </div>
                    <div class="field" style="margin:0">
                      <label style="font-size:.75rem" for="sa-${s.id}">Amount</label>
                      <input id="sa-${s.id}" name="amount" class="amount-input" type="text"
                             inputmode="decimal" style="max-width:8rem"
                             value="${s.amount !== null ? (Math.abs(s.amount) / 100).toFixed(2) : ""}">
                    </div>
                    <div class="field" style="margin:0">
                      <label style="font-size:.75rem" for="sd-${s.id}">In or out</label>
                      <select id="sd-${s.id}" name="direction">
                        <option value="out" ${raw((s.amount ?? 0) <= 0 ? "selected" : "")}>Out</option>
                        <option value="in" ${raw((s.amount ?? 0) > 0 ? "selected" : "")}>In</option>
                      </select>
                    </div>
                    <div class="field" style="margin:0">
                      <label style="font-size:.75rem" for="sr-${s.id}">How often</label>
                      <select id="sr-${s.id}" name="recurrence">
                        ${(["monthly", "weekly", "fortnightly", "quarterly", "yearly"] as const).map(
                          (r) => html`
                            <option value="${r}" ${raw(r === s.recurrence ? "selected" : "")}>${r}</option>
                          `,
                        )}
                      </select>
                    </div>
                    <div class="field" style="margin:0">
                      <label style="font-size:.75rem" for="su-${s.id}">Next due</label>
                      <input id="su-${s.id}" name="next_due" type="date" value="${s.next_due ?? ""}">
                    </div>
                    <div class="field" style="margin:0">
                      <label style="font-size:.75rem" for="sc-${s.id}">Envelope</label>
                      <!--
                        A schedule's split lines are posted by a different form
                        below, so the browser cannot see them from here. The
                        server knows, and says so: with lines set, this envelope
                        is not what the schedule posts to and the lines are.
                      -->
                      <select id="sc-${s.id}" name="category_id" style="max-width:12rem"
                              ${raw((opts.splits?.get(s.id)?.length ?? 0) > 0 ? "disabled" : "")}>
                        <option value="">
                          ${(opts.splits?.get(s.id)?.length ?? 0) > 0
                            ? "Split — the lines below carry the envelopes"
                            : "Not set"}
                        </option>
                        ${(opts.categories ?? []).map(
                          (c) => html`
                            <option value="${c.id}" ${raw(c.id === s.category_id ? "selected" : "")}>
                              ${c.name}
                            </option>
                          `,
                        )}
                      </select>
                    </div>
                    <div class="field" style="margin:0">
                      <label style="font-size:.75rem" for="sacc-${s.id}">Account</label>
                      <select id="sacc-${s.id}" name="account_id" style="max-width:12rem">
                        <option value="">Not set</option>
                        ${(opts.accounts ?? []).map(
                          (acc) => html`
                            <option value="${acc.id}" ${raw(acc.id === s.account_id ? "selected" : "")}>
                              ${acc.name}
                            </option>
                          `,
                        )}
                      </select>
                    </div>
                    <button class="button-small" type="submit">Save</button>
                  </form>
                  ${when(
                    s.amount !== null && (opts.categories?.length ?? 0) > 0,
                    () => {
                      const lines = opts.splits?.get(s.id) ?? [];
                      /*
                       * Four rows is enough for a salary (PF, tax, net) with one
                       * spare, and a fixed number keeps this a plain form rather
                       * than something that needs scripting to add a row.
                       */
                      const slots = Math.max(4, lines.length + 1);
                      return html`
                        <form method="post" action="/schedules/${s.id}/splits" style="margin-top:.6rem">
                          <p class="field-hint" style="margin:0 0 .4rem">
                            Split it across envelopes. The lines have to add up to
                            ${formatPaise(s.amount!)} — leave them all empty to stop
                            splitting.
                          </p>
                          ${Array.from({ length: slots }, (_unused, i) => {
                            const line = lines[i];
                            return html`
                              <div class="row" style="gap:.4rem;margin-bottom:.3rem">
                                <select name="split_category_${i}" style="max-width:11rem">
                                  <option value="">No envelope</option>
                                  ${(opts.categories ?? []).map((c) => html`
                                    <option value="${c.id}" ${raw(line?.category_id === c.id ? "selected" : "")}>
                                      ${c.name}
                                    </option>
                                  `)}
                                </select>
                                <input name="split_amount_${i}" inputmode="decimal"
                                       style="max-width:7rem" placeholder="0.00"
                                       value="${line ? (line.amount / 100).toFixed(2) : ""}">
                              </div>
                            `;
                          })}
                          <button class="button-small" type="submit">Save the split</button>
                        </form>
                      `;
                    },
                  )}
                  <form method="post" action="/schedules/${s.id}/delete" style="margin-top:.4rem"
                        onsubmit="return confirm('Remove this schedule? Anything it already recorded stays.')">
                    <button class="button-small button-danger" type="submit">Remove</button>
                  </form>
                </details>
              </div>
            `,
          )}
    </section>

    ${when(opts.detected.length > 0, () => html`
      <section class="card">
        <h2>Look like schedules <span class="chip">${opts.detected.length}</span></h2>
        <p class="faint" style="margin-top:-.25rem">
          Spotted in your own history. Nothing is added until you confirm it.
        </p>
        ${opts.detected.map(
          (d) => html`
            <form method="post" action="/schedules/confirm"
                  class="row-between" style="padding:.6rem 0;border-top:1px solid var(--border)">
              <input type="hidden" name="payee_id" value="${d.payeeId}">
              <input type="hidden" name="name" value="${d.payeeName}">
              <input type="hidden" name="amount" value="${d.amount}">
              <input type="hidden" name="recurrence" value="${d.recurrence}">
              <input type="hidden" name="next_due" value="${d.nextDue}">
              <input type="hidden" name="category_id" value="${d.categoryId ?? ""}">
              <input type="hidden" name="account_id" value="${d.accountId}">
              <div>
                <strong>${d.payeeName}</strong>
                <span class="chip chip-${d.confidence === "high" ? "positive" : "warning"}">
                  ${d.confidence} confidence
                </span>
                <div class="faint">
                  ${formatPaise(Math.abs(d.amount))} ${d.recurrence}, seen ${d.occurrences} times ·
                  next ${formatDate(d.nextDue)}
                </div>
              </div>
              <div class="row">
                <button class="button-small button-primary" type="submit">Add it</button>
                <button class="button-small" type="submit" formaction="/schedules/dismiss">Not a schedule</button>
              </div>
            </form>
          `,
        )}
      </section>
    `)}

    ${when(opts.subscriptions.length > 0, () => html`
      <section class="card">
        <h2>Subscriptions
          <span class="faint" style="font-size:.9rem;font-weight:400">
            ${formatPaise(opts.subscriptions.reduce((s, x) => s + x.annualised, 0))}/yr total
          </span>
        </h2>
        <p class="faint" style="margin-top:-.25rem">
          What each one costs over a year.
        </p>
        ${horizontalBars({
          title: "Annual cost of each subscription",
          items: opts.subscriptions.map((s) => ({ label: s.schedule.name, value: s.annualised })),
        })}
      </section>
    `)}
  `;
}

/**
 * S15 · The cashflow trajectory — projected Budget-account balance across the
 * window, with the floor as a reference. A dip below it is the answer to
 * "will I make it?", already flagged in words above.
 */
function cashflowChart(cashflow: Cashflow): SafeHtml {
  if (cashflow.days.length < 2) return raw("");
  const points = [cashflow.openingBalance, ...cashflow.days.map((d) => d.projectedBalance)];
  const xLabels = ["now", ...cashflow.days.map((d) => formatDate(d.date).slice(0, 5))];
  const series = [{
    label: "Projected balance",
    color: cashflow.firstShortfall ? "var(--danger)" : "var(--accent)",
    points: points.map((p) => p / 100),
    fill: true,
  }];
  // The floor as a flat reference line, when it isn't zero.
  if (cashflow.floor > 0) {
    series.push({
      label: "Floor",
      color: "var(--text-faint)",
      points: points.map(() => cashflow.floor / 100),
      fill: false,
    });
  }
  return lineChart({ title: "Projected balance over the window", xLabels, series });
}

/**
 * B51 · Add a schedule by hand.
 *
 * `POST /schedules/new` shipped, but the "Add one" button linked to a GET that
 * did not exist (405), so schedules could only ever arrive through the
 * detector's confirm path. This is the manual form it pointed at.
 */
export function renderNewScheduleForm(opts: {
  accounts: { id: string; name: string; nickname: string | null }[];
  categories: { id: string; name: string }[];
  today: IsoDate;
}): SafeHtml {
  return html`
    <h1>Add a schedule</h1>
    <p class="faint">
      A recurring item the app should expect — rent, a SIP, a subscription. It shapes
      the cashflow forecast; it does not move money on its own.
    </p>
    <form method="post" action="/schedules/new" class="card">
      <div class="field">
        <label for="name">What is it?</label>
        <input id="name" name="name" autocomplete="off" required autofocus
               placeholder="Rent, Netflix, SIP…">
      </div>
      <div class="grid-2">
        <div class="field">
          <label for="amount">Amount</label>
          <input id="amount" name="amount" class="amount-input" type="text"
                 inputmode="decimal" autocomplete="off" placeholder="0.00">
        </div>
        <div class="field">
          <!--
            F7 · Money arriving is a schedule too. Everything here was forced
            negative, so a salary could not be recorded — and the cashflow
            calendar's whole question, "will I make it to the 30th", depends on
            knowing when money comes in as much as when it goes out.
          -->
          <label for="sched-direction">Money in or out</label>
          <select id="sched-direction" name="direction">
            <option value="out">Going out — a bill or a subscription</option>
            <option value="in">Coming in — salary, rent received, a retainer</option>
          </select>
        </div>
      </div>
      <div class="grid-2">
        <div class="field">
          <label for="next_due">Next due</label>
          <input id="next_due" name="next_due" type="date" autocomplete="off"
                 value="${opts.today}">
        </div>
        <div class="field">
          <label for="recurrence">How often</label>
          <select id="recurrence" name="recurrence">
            <option value="monthly">Monthly</option>
            <option value="weekly">Weekly</option>
            <option value="fortnightly">Fortnightly</option>
            <option value="quarterly">Quarterly</option>
            <option value="yearly">Yearly</option>
          </select>
        </div>
        <div class="field">
          <label for="account_id">Account</label>
          <select id="account_id" name="account_id">
            <option value="">Any / not set</option>
            ${opts.accounts.map(
              (a) => html`<option value="${a.id}">${a.nickname || a.name}</option>`,
            )}
          </select>
        </div>
      </div>
      <div class="field">
        <label for="category_id">Which envelope</label>
        <select id="category_id" name="category_id" data-split-aware>
          <option value="">Not set — only for money coming in</option>
          ${opts.categories.map((c) => html`<option value="${c.id}">${c.name}</option>`)}
        </select>
        <!--
          F7.4 · A schedule shows on the budget screen against its category, and
          B99's rule applies to a payment the app posts every month as much as to
          one typed by hand — so money out needs an envelope, and "Uncategorised"
          is no longer on offer for it.
        -->
        <p class="field-hint">
          Money going out needs one: a scheduled payment posts itself, so without
          an envelope it would quietly build a queue of spending with nothing
          recording where it went. Money coming in lands in Ready to Assign.
        </p>
      </div>
      <div class="field">
        <label><input type="checkbox" name="is_subscription" value="1"> This is a subscription</label>
      </div>

      <!--
        Splitting at creation, not only afterwards.

        The two most regular payments a household has are both splits — a salary
        into provident fund, tax and what landed; rent into rent and
        maintenance. The lines could only be set on an existing schedule, so
        recording either meant creating it wrong and then editing.
      -->
      <details class="field">
        <summary class="linkish">Split across envelopes</summary>
        <p class="field-hint">
          Fill in two or more lines and they must add up to the amount above.
          Leave them blank for a schedule that posts to one envelope.
        </p>
        ${[0, 1, 2].map((i) => html`
          <div class="row" style="gap:.4rem;margin-bottom:.3rem">
            <select name="split_category_${i}" style="max-width:11rem"
                    aria-label="Split ${i + 1} envelope">
              <option value="">—</option>
              ${(opts.categories ?? []).map((c) => html`
                <option value="${c.id}">${c.name}</option>
              `)}
            </select>
            <input name="split_amount_${i}" inputmode="decimal" style="max-width:7rem"
                   placeholder="0.00" aria-label="Split ${i + 1} amount">
          </div>
        `)}
      </details>

      <button class="button-primary" type="submit">Add schedule</button>
      <a class="button button-quiet" href="/schedules">Cancel</a>
    </form>
  `;
}

/** 03 §6: a vertical list of days on mobile rather than a month grid. */
function renderCalendar(cashflow: Cashflow): SafeHtml {
  const busy = cashflow.days.filter(
    (d) => d.inflows.length > 0 || d.outflows.length > 0 || d.belowFloor,
  );

  if (busy.length === 0) {
    return html`
      <p class="faint">
        Nothing scheduled in this window. Your projected balance stays at
        ${formatPaise(cashflow.openingBalance)}.
      </p>
    `;
  }

  return html`
    <div class="table-scroll" style="max-height:28rem;overflow-y:auto">
      ${busy.map((day) => renderCalendarDay(day))}
    </div>
  `;
}

function renderCalendarDay(day: CalendarDay): SafeHtml {
  return html`
    <div class="${day.belowFloor ? "state-overspent" : ""}"
         style="padding:.6rem 1rem;border-top:1px solid var(--border)">
      <div class="row-between">
        <strong>${formatDate(day.date)}</strong>
        <span>
          <span class="amount ${day.negative ? "amount-negative" : ""}">
            ${formatPaise(day.projectedBalance)}
          </span>
          ${when(day.belowFloor, () => html`
            <span class="chip chip-danger">below your floor</span>
          `)}
        </span>
      </div>
      ${day.outflows.map(
        (f) => html`
          <div class="faint">
            − ${formatPaise(f.amount)} ${f.label}
            ${when(!f.confirmed, () => html`<span class="chip">detected</span>`)}
          </div>
        `,
      )}
      ${day.inflows.map(
        (f) => html`<div class="faint">+ ${formatPaise(f.amount)} ${f.label}</div>`,
      )}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// S9 · Goals
// ---------------------------------------------------------------------------

export function renderGoals(opts: {
  goals: GoalProgress[];
  /** 15 §6B · The budgets a goal could belong to. One means no choice to make. */
  budgets?: { id: string; name: string; kind: string }[];
}): SafeHtml {
  const budgets = opts.budgets ?? [];
  return html`
    <div class="row-between" style="margin-bottom:1rem">
      <h1>Goals</h1>
    </div>

    ${opts.goals.length === 0
      ? html`
          <div class="card empty-state">
            <div class="empty-icon" aria-hidden="true">◎</div>
            <h2>No goals yet</h2>
            <p>
              A goal tracks a long-horizon intention across one or more categories.
              It holds no money of its own, so it can never disagree with your budget.
            </p>
          </div>
        `
      : opts.goals.map((g) => renderGoalCard(g))}

    <section class="card">
      <h2>Add a goal</h2>
      <form method="post" action="/goals/new">
        <div class="grid-2">
          <div class="field">
            <label for="name">What for?</label>
            <input id="name" name="name" required placeholder="Kerala trip">
          </div>
          <div class="field">
            <label for="target_amount">How much?</label>
            <input id="target_amount" name="target_amount" class="amount-input"
                   type="text" inputmode="decimal" required>
          </div>
        </div>
        <div class="field">
          <label for="target_date">By when <span class="faint">(optional)</span></label>
          <input type="date" id="target_date" name="target_date">
          <p class="field-hint">
            With a date, the goal tells you what to put aside each month. Each goal
            gets its own savings envelope, created and kept in step automatically.
          </p>
        </div>
        ${when(budgets.length > 1, () => html`
          <!--
            15 §6B · Chosen once. A goal is measured by its envelope's balance, so
            moving it later would change what months of watched history meant —
            there is deliberately no edit for this.
          -->
          <div class="field">
            <label for="goal-budget">Shared or your own?</label>
            <select id="goal-budget" name="budget_id">
              ${budgets.map(
                (b) => html`
                  <option value="${b.id}">
                    ${b.kind === "household" ? "Shared — the household's goal" : `Mine — ${b.name}'s own`}
                  </option>
                `,
              )}
            </select>
            <p class="field-hint">
              This cannot be changed later: the goal's progress is its envelope's
              balance, and moving it between budgets would change what the months
              you have been watching meant.
            </p>
          </div>
        `)}
        <button class="button-primary" type="submit">Add it</button>
      </form>
    </section>
  `;
}

function renderGoalCard(g: GoalProgress): SafeHtml {
  const percent = Math.round(g.percent);
  return html`
    <section class="card">
      <div class="goal-ring-row">
        ${progressRing({
          percent: g.percent,
          title: `${g.goal.name}: ${percent}% saved`,
          color: g.reached ? "var(--positive)" : "var(--accent)",
        })}
        <div style="flex:1 1 auto;min-width:0">
          <div class="row-between">
            <h2 style="margin-bottom:.15rem">${g.goal.name}</h2>
            ${when(g.reached, () => html`<span class="chip chip-positive">reached</span>`)}
          </div>
          <p class="faint" style="margin:0">
            ${formatPaise(g.saved)} of ${formatPaise(g.goal.target_amount)}
            ${when(g.goal.target_date, () => html` · by ${formatDate(g.goal.target_date!)}`)}
          </p>
          <p class="muted" style="margin:.35rem 0 0">${g.reading}</p>
        </div>
      </div>

      <div class="faint">
        Held in ${g.categories.map((c) => c.name).join(", ")}
      </div>

      ${when(g.reached, () => html`
        <form method="post" action="/goals/${g.goal.id}/complete" style="margin-top:.75rem">
          <div class="row" style="flex-wrap:wrap">
            <button class="button-small" name="resolution" value="spend" type="submit">Spend it</button>
            <button class="button-small" name="resolution" value="roll" type="submit">Roll into a new goal</button>
            <button class="button-small" name="resolution" value="release" type="submit">Back to Ready to Assign</button>
          </div>
        </form>
      `)}

      <!-- F11 · Edit and delete. -->
      <details style="margin-top:.75rem">
        <summary style="min-height:36px;display:flex;align-items:center;cursor:pointer;color:var(--text-muted);font-size:.9rem">
          Edit or remove
        </summary>
        <form method="post" action="/goals/${g.goal.id}/edit" style="margin-top:.5rem">
          <div class="grid-2">
            <div class="field">
              <label for="name-${g.goal.id}">Name</label>
              <input id="name-${g.goal.id}" name="name" required value="${g.goal.name}">
            </div>
            <div class="field">
              <label for="target-${g.goal.id}">Target</label>
              <input id="target-${g.goal.id}" name="target_amount" class="amount-input"
                     type="text" inputmode="decimal" required value="${(g.goal.target_amount / 100).toFixed(2)}">
            </div>
          </div>
          <div class="field">
            <label for="date-${g.goal.id}">By when <span class="faint">(optional)</span></label>
            <input type="date" id="date-${g.goal.id}" name="target_date"
                   value="${g.goal.target_date ?? ""}">
          </div>
          <button class="button-primary" type="submit">Save changes</button>
        </form>
        <form method="post" action="/goals/${g.goal.id}/delete" style="margin-top:.5rem">
          <button class="button-danger" type="submit">Delete goal</button>
          <span class="faint" style="margin-left:.5rem">The money stays in its category.</span>
        </form>
      </details>
    </section>
  `;
}
