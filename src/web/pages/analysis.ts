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
import { formatPaise, formatCompact, type Paise } from "../../core/money.ts";
import { formatDate, formatMonth, type IsoDate } from "../../core/dates.ts";
import type { QueryRow, GroupedTotal, GroupBy, Period, TrendPoint } from "../../domain/reports.ts";
import type { Schedule, DetectedSchedule, Cashflow, CalendarDay } from "../../domain/schedules.ts";
import type { GoalProgress } from "../../domain/goals.ts";

// ---------------------------------------------------------------------------
// S7 · Query
// ---------------------------------------------------------------------------

export interface QueryOptions {
  rows: QueryRow[];
  groups: GroupedTotal[];
  groupBy: GroupBy;
  period: Period;
  periods: Period[];
  text: string;
  accounts: { id: string; name: string }[];
  categories: { id: string; name: string }[];
  selectedAccounts: string[];
  selectedCategories: string[];
  title?: string;
}

export function renderQuery(opts: QueryOptions): SafeHtml {
  const total = opts.rows.reduce((sum, r) => sum + r.amount, 0);
  const outflow = opts.rows.filter((r) => r.amount < 0).reduce((sum, r) => sum + r.amount, 0);
  const inflow = opts.rows.filter((r) => r.amount > 0).reduce((sum, r) => sum + r.amount, 0);

  return html`
    <div class="row-between" style="margin-bottom:1rem">
      <h1>${opts.title ?? "Query"}</h1>
      <a class="button button-small" href="/query.csv${filterQueryString(opts)}">Export CSV</a>
    </div>

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
          <strong style="font-size:1.15rem">${opts.rows.length}</strong>
        </div>
      </div>
      <p class="field-hint">
        ${formatDate(opts.period.from)} to ${formatDate(opts.period.to)}
      </p>
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
                    <th scope="col" class="num">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  ${opts.rows.slice(0, 300).map(
                    (r) => html`
                      <tr>
                        <td>${formatDate(r.date)}</td>
                        <td><a href="/transaction/${r.id}">${r.payee ?? "—"}</a></td>
                        <td>
                          ${r.category ?? html`<span class="chip chip-warning">Uncategorised</span>`}
                        </td>
                        <td class="faint">${r.account}</td>
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

function filterQueryString(opts: QueryOptions): string {
  const params = new URLSearchParams({ period: opts.period.key, group_by: opts.groupBy });
  if (opts.text) params.set("q", opts.text);
  return `?${params}`;
}

// ---------------------------------------------------------------------------
// S6 · Reports
// ---------------------------------------------------------------------------

export function renderReports(opts: {
  trend: TrendPoint[];
  period: Period;
  periods: Period[];
  loanInterest: { fy: number; label: string; interest: Paise; principal: Paise; lender: string }[];
}): SafeHtml {
  const peak = Math.max(...opts.trend.flatMap((t) => [t.income, t.spending]), 1);

  return html`
    <h1>Reports</h1>
    <p class="muted">
      Each of these is the query screen with a filter already applied — open any of
      them and you can change it.
    </p>

    <section class="card">
      <h2>Income and spending</h2>
      ${opts.trend.length === 0
        ? html`<p class="faint">Not enough history yet.</p>`
        : html`
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
          April to March, for your own records. This app computes no tax liability
          and gives no advice — it states what was paid.
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
              <div class="row-between" style="padding:.6rem 0;border-top:1px solid var(--border)">
                <div>
                  <strong>${s.name}</strong>
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
                  <span class="amount">${s.amount !== null ? formatPaise(Math.abs(s.amount)) : "—"}</span>
                  <form method="post" action="/schedules/${s.id}/paid">
                    <button class="button-small" type="submit">Paid</button>
                  </form>
                  <form method="post" action="/schedules/${s.id}/skip">
                    <button class="button-small button-quiet" type="submit">Skip</button>
                  </form>
                </div>
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
        <h2>Subscriptions</h2>
        <p class="faint" style="margin-top:-.25rem">
          What each one costs over a year, which is the figure worth deciding on.
        </p>
        ${opts.subscriptions.map(
          (s) => html`
            <div class="row-between" style="padding:.4rem 0;border-top:1px solid var(--border)">
              <span>${s.schedule.name}</span>
              <span>
                <span class="faint">${formatPaise(Math.abs(s.schedule.amount ?? 0))} ${s.schedule.recurrence}</span>
                <strong class="amount" style="margin-left:.75rem">${formatPaise(s.annualised)}/yr</strong>
              </span>
            </div>
          `,
        )}
      </section>
    `)}
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
  categories: { id: string; name: string }[];
}): SafeHtml {
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
        <div class="grid-2">
          <div class="field">
            <label for="target_date">By when <span class="faint">(optional)</span></label>
            <input id="target_date" name="target_date" placeholder="DD-MM-YYYY">
            <p class="field-hint">With a date, the goal can tell you what to put aside each month.</p>
          </div>
          <div class="field">
            <label for="category_ids">Which category holds it?</label>
            <select id="category_ids" name="category_ids" required>
              ${opts.categories.map((c) => html`<option value="${c.id}">${c.name}</option>`)}
            </select>
          </div>
        </div>
        <button class="button-primary" type="submit">Add it</button>
      </form>
    </section>
  `;
}

function renderGoalCard(g: GoalProgress): SafeHtml {
  const percent = Math.round(g.percent);
  return html`
    <section class="card">
      <div class="row-between">
        <div>
          <h2 style="margin-bottom:.15rem">${g.goal.name}</h2>
          <p class="faint" style="margin:0">
            ${formatPaise(g.saved)} of ${formatPaise(g.goal.target_amount)}
            ${when(g.goal.target_date, () => html` · by ${formatDate(g.goal.target_date!)}`)}
          </p>
        </div>
        <div style="text-align:right">
          <strong style="font-size:1.3rem">${percent}%</strong>
          ${when(g.reached, () => html`<div><span class="chip chip-positive">reached</span></div>`)}
        </div>
      </div>

      <span class="target-bar ${g.reached ? "" : percent > 0 ? "partial" : "unfunded"}"
            style="max-width:100%;height:8px;margin:.5rem 0" role="img"
            aria-label="${percent}% of ${formatPaise(g.goal.target_amount)} saved">
        <span style="width:${percent}%"></span>
      </span>

      <p class="muted" style="margin:.25rem 0">${g.reading}</p>

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
    </section>
  `;
}
