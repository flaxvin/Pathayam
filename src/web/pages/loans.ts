/**
 * S12 · Loans.
 *
 * `06` §1: "expose one number the household actually acts on: what a rupee of
 * prepayment buys". So the prepayment comparison is the centrepiece, not a
 * tab three levels down.
 */

import { html, raw, when, type SafeHtml } from "../../http/html.ts";
import { formatPaise, formatCompact, type Paise } from "../../core/money.ts";
import { formatDate, type IsoDate } from "../../core/dates.ts";
import type { LoanProjection, Loan, LoanPayment, Disbursement, DebtRow } from "../../domain/loans.ts";
import { LOAN_TYPE_LABELS } from "../../domain/loans.ts";
import type { PrepaymentComparison, Schedule, RateResetOptions } from "../../loans/amortisation.ts";
import { lineChart, horizontalBars } from "../charts.ts";
import { renderHolderFields } from "./portfolio.ts";

export function renderLoanList(rows: LoanProjection[], debt: DebtRow[]): SafeHtml {
  if (rows.length === 0) {
    return html`
      <div class="row-between" style="margin-bottom:1rem">
        <h1>Loans</h1>
        <a class="button" href="/loans/what-if">Prepayment calculator</a>
      </div>
      <div class="card empty-state">
        <div class="empty-icon" aria-hidden="true">▽</div>
        <h2>No loans yet</h2>
        <p>
          Add one to see what it really costs, and what a rupee of prepayment buys.
        </p>
        <p>
          <a class="button button-primary" href="/loans/new">Add a loan</a>
          <a class="button" href="/loans/what-if">Try the calculator first</a>
        </p>
      </div>
    `;
  }

  const totalOwed = rows.reduce((sum, r) => sum + r.outstanding, 0);
  const monthly = rows.reduce((sum, r) => sum + (r.preEmi ?? r.emi), 0);

  return html`
    <div class="row-between" style="margin-bottom:1rem">
      <h1>Loans</h1>
      <div class="row">
        <a class="button" href="/loans/what-if">Prepayment calculator</a>
        <a class="button button-primary" href="/loans/new">Add a loan</a>
      </div>
    </div>

    <div class="card">
      <div class="row" style="gap:2rem;flex-wrap:wrap">
        <div>
          <div class="faint">Total owed</div>
          <strong class="amount amount-negative" style="font-size:1.3rem">${formatPaise(totalOwed)}</strong>
        </div>
        <div>
          <div class="faint">Every month</div>
          <strong class="amount" style="font-size:1.3rem">${formatPaise(monthly)}</strong>
        </div>
      </div>
      ${when(rows.filter((r) => r.outstanding > 0).length > 1, () => html`
        <h3 style="margin:.75rem 0 .25rem;font-size:.95rem">Outstanding by loan</h3>
        ${horizontalBars({
          title: "Outstanding balance by loan",
          items: rows
            .filter((r) => r.outstanding > 0)
            .map((r) => ({ label: r.loan.nickname || r.loan.lender, value: r.outstanding, color: "var(--danger)" })),
        })}
      `)}
    </div>

    ${rows.map((r) => renderLoanCard(r))}

    ${when(debt.length > 0, () => html`
      <section class="card">
        <h2>Everything you owe</h2>
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">What</th>
                <th scope="col" class="num">Balance</th>
                <th scope="col" class="num">Rate</th>
                <th scope="col" class="num">Monthly</th>
                <th scope="col" class="num">Left</th>
              </tr>
            </thead>
            <tbody>
              ${debt.map(
                (d) => html`
                  <tr>
                    <td>${d.name} <span class="chip">${d.kind === "loan" ? "loan" : "card"}</span></td>
                    <td class="num amount amount-negative">${formatPaise(d.balance)}</td>
                    <td class="num">${d.ratePct !== null ? `${d.ratePct}%` : "—"}</td>
                    <td class="num amount">${d.monthlyObligation ? formatPaise(d.monthlyObligation) : "—"}</td>
                    <td class="num">${d.monthsRemaining ?? "—"}</td>
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

function renderLoanCard(p: LoanProjection): SafeHtml {
  const loan = p.loan;
  return html`
    <section class="card">
      <div class="row-between">
        <div>
          <h2 style="margin-bottom:.15rem">
            <a href="/loans/${loan.id}" style="color:inherit">
              ${loan.nickname || loan.lender}
            </a>
          </h2>
          <p class="faint" style="margin:0">
            ${LOAN_TYPE_LABELS[loan.loan_type]} · ${p.ratePct}%
            ${when(p.equivalentReducingRatePct !== null, () => html`
              <!-- R16 M2: the headline rate is not the rate that matters. -->
              <span class="chip chip-warning">
                quoted flat — really ${p.equivalentReducingRatePct!.toFixed(2)}% reducing
              </span>
            `)}
          </p>
        </div>
        <div style="text-align:right">
          <strong class="amount amount-negative" style="font-size:1.2rem">
            ${formatPaise(p.outstanding)}
          </strong>
          <div class="faint">${p.schedule.months} instalments left</div>
        </div>
      </div>

      ${when(p.undrawn > 0, () => html`
        <p class="notice notice-info">
          ${formatPaise(p.disbursed)} drawn of ${formatPaise(loan.sanctioned)} sanctioned.
          ${formatPaise(p.undrawn)} undrawn — not a liability, and not money you hold.
          ${when(p.preEmi !== null, () => html`
            The monthly obligation is pre-EMI of <strong>${formatPaise(p.preEmi!)}</strong>,
            interest only.
          `)}
        </p>
      `)}

      ${when(p.driftMaterial && p.driftAmount !== null, () => html`
        <p class="notice notice-warning">
          The lender's statement of ${formatDate(p.driftAsOf!)} differs from this app by
          ${formatPaise(Math.abs(p.driftAmount!))} — the app is
          ${p.driftAmount! > 0 ? "higher" : "lower"}.
          Common and legitimate causes: a mid-cycle rate reset, value-date versus
          due-date differences, part-month interest on the first instalment,
          rounding conventions, or fees added to principal.
          <a href="/loans/${p.loan.id}/statement">Resolve it</a>
        </p>
      `)}

      <div class="row" style="gap:2rem;flex-wrap:wrap;margin-top:.5rem">
        ${figure("Monthly", p.preEmi ?? p.emi)}
        ${figure("Interest paid so far", p.metrics.interestPaid, "actual")}
        ${figure("Interest still to pay", p.schedule.totalInterest, "projected")}
        ${when(p.metrics.interestSaved !== 0, () =>
          figure("Interest saved", p.metrics.interestSaved, "projected"))}
      </div>

      ${moratoriumNotice(p)}

      <div class="row" style="flex-wrap:wrap;margin-top:.75rem">
        <a class="button button-small" href="/loans/${loan.id}">Schedule</a>
        <a class="button button-small" href="/loans/${loan.id}/pay">Record an instalment</a>
        <a class="button button-small button-primary" href="/loans/${loan.id}/prepay">Prepay</a>
      </div>
    </section>
  `;
}

/**
 * B51 · R16's moratorium notice — shared by the list card and the loan detail
 * page. It used to live only in the card, so the loan's own page, where a
 * household goes to read about the loan, showed neither the moratorium state
 * nor the capitalisation warning that makes M4 expensive.
 */
function moratoriumNotice(p: LoanProjection): SafeHtml {
  return when(p.moratorium !== null, () => html`
    <p class="notice ${p.moratorium!.capitalised ? "notice-warning" : "notice-info"}"
       style="margin-top:.75rem">
      ${p.moratorium!.capitalised
        ? html`
            In its <strong>${p.moratorium!.months}-month moratorium</strong>, with
            interest <strong>capitalised</strong>. You pay nothing now, but
            <strong>${formatPaise(p.moratorium!.capitalisedInterest)}</strong> of
            interest is rolling into what you owe — repayment will start against
            <strong>${formatPaise(p.moratorium!.balanceAtRepaymentStart)}</strong>,
            not the original amount. Servicing the interest instead would avoid all
            of that.
          `
        : html`
            In its <strong>${p.moratorium!.months}-month moratorium</strong>, interest
            <strong>serviced</strong> monthly — the principal stays put and nothing
            is capitalised. Interest of
            <strong>${formatPaise(p.moratorium!.totalServiced)}</strong> is paid
            across the moratorium before full instalments begin.
          `}
    </p>
  `);
}

/**
 * S15 · The amortisation curve — how the outstanding balance falls to zero over
 * the projected schedule. Sampled so a 240-month loan stays a smooth line, not
 * 240 points of markup.
 */
function loanBalanceSection(p: LoanProjection): SafeHtml {
  const rows = p.schedule.instalments;
  if (rows.length < 2 || p.outstanding <= 0) return raw("");

  const step = Math.max(1, Math.ceil(rows.length / 48));
  const sampled = rows.filter((_, i) => i % step === 0 || i === rows.length - 1);
  // Prepend today's outstanding as the starting point.
  const points = [p.outstanding / 100, ...sampled.map((r) => r.closing / 100)];
  const labelFor = (r: (typeof rows)[number]) =>
    r.dueDate ? formatDate(r.dueDate).slice(3) : `#${r.number}`;
  const xLabels = ["now", ...sampled.map(labelFor)];

  return html`
    <section class="card">
      <h2>How it pays down</h2>
      <p class="faint" style="margin-top:-.25rem">
        The projected balance from today to close, if nothing changes.
        ${when(p.schedule.months > 0, () => html`
          About ${p.schedule.months} instalments left.
        `)}
      </p>
      ${lineChart({
        title: "Projected outstanding balance over the remaining schedule",
        xLabels,
        series: [{ label: "Outstanding", color: "var(--accent)", points, fill: true }],
      })}
    </section>
  `;
}

/**
 * S15 · The drawdown — cumulative disbursed against the sanction, for a loan
 * that draws in tranches. Only shown when there is more than one draw or an
 * undrawn balance remains, since a single-shot loan has nothing to plot.
 */
function loanDrawdownSection(p: LoanProjection, disbursements: Disbursement[]): SafeHtml {
  if (disbursements.length < 2 && p.undrawn <= 0) return raw("");
  if (disbursements.length === 0) return raw("");

  const sorted = [...disbursements].sort((a, b) => a.date.localeCompare(b.date));
  let cum = 0;
  const drawn: number[] = [];
  const labels: string[] = [];
  for (const d of sorted) {
    cum += d.amount;
    drawn.push(cum / 100);
    labels.push(formatDate(d.date).slice(3));
  }
  // A trailing "today" point so an undrawn balance is visible as a flat line
  // below the sanction ceiling.
  if (p.undrawn > 0) { drawn.push(cum / 100); labels.push("now"); }
  const sanctionLine = drawn.map(() => p.loan.sanctioned / 100);

  return html`
    <section class="card">
      <h2>Drawdown</h2>
      <p class="faint" style="margin-top:-.25rem">
        ${formatPaise(p.disbursed)} drawn of ${formatPaise(p.loan.sanctioned)} sanctioned
        ${when(p.undrawn > 0, () => html`· ${formatPaise(p.undrawn)} still undrawn`)}.
      </p>
      ${lineChart({
        title: "Cumulative amount drawn against the sanction",
        xLabels: labels,
        series: [
          { label: "Sanctioned", color: "var(--text-faint)", points: sanctionLine },
          { label: "Drawn", color: "var(--chart-3)", points: drawn, fill: true },
        ],
      })}
    </section>
  `;
}

/** R22.1 · Every metric says whether it is actual or projected, in the label. */
function figure(label: string, amount: Paise, basis?: "actual" | "projected"): SafeHtml {
  return html`
    <div>
      <div class="faint">
        ${label}
        ${when(basis, () => html`<span class="chip">${basis}</span>`)}
      </div>
      <strong class="amount">${formatPaise(amount)}</strong>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Loan detail
// ---------------------------------------------------------------------------

export function renderLoanDetail(opts: {
  projection: LoanProjection;
  payments: LoanPayment[];
  disbursements: Disbursement[];
  rates: { effective_from: IsoDate; annual_rate_pct: number }[];
  budgetAccounts: { id: string; name: string }[];
}): SafeHtml {
  const p = opts.projection;
  const loan = p.loan;

  return html`
    <div class="row-between" style="margin-bottom:1rem">
      <div>
        <h1 style="margin-bottom:.15rem">${loan.nickname || loan.lender}</h1>
        <p class="faint" style="margin:0">
          ${LOAN_TYPE_LABELS[loan.loan_type]} · sanctioned ${formatPaise(loan.sanctioned)}
          on ${formatDate(loan.sanction_date)}
        </p>
      </div>
      <div class="row">
        <a class="button" href="/loans/${loan.id}/pay">Record an instalment</a>
        <a class="button" href="/loans/${loan.id}/rate">Rate change</a>
        <a class="button button-primary" href="/loans/${loan.id}/prepay">Prepay</a>
      </div>
    </div>

    ${when(loan.history_from, () => html`
      <!-- R22.3: never presented as complete when history predates the app. -->
      <p class="notice notice-info">
        This loan was created part-way through its life. Lifetime figures below are
        <strong>from ${formatDate(loan.history_from!)}</strong>, not from origination.
      </p>
    `)}

    <section class="card">
      <h2>Where it stands</h2>
      <div class="row" style="gap:2rem;flex-wrap:wrap">
        ${figure("Sanctioned", loan.sanctioned)}
        ${figure("Disbursed", p.disbursed)}
        ${figure("Undrawn", p.undrawn)}
        ${figure("Outstanding", p.outstanding, "actual")}
        ${figure("Monthly", p.preEmi ?? p.emi)}
      </div>
      <p class="field-hint">
        Only what has been disbursed is a liability. The undrawn balance is neither
        money you owe nor money you hold.
      </p>
      ${when(p.preEmi !== null, () => html`
        <!-- B51: the actual current obligation, absent from this page before. -->
        <p class="notice notice-info">
          While the loan is part-drawn the monthly obligation is a pre-EMI of
          <strong>${formatPaise(p.preEmi!)}</strong>, interest only — full instalments
          of ${formatPaise(p.emi)} begin once it is fully disbursed.
        </p>
      `)}
      ${moratoriumNotice(p)}
    </section>

    ${loanBalanceSection(p)}
    ${loanDrawdownSection(p, opts.disbursements)}

    <section class="card">
      <h2>Lifetime</h2>
      <div class="row" style="gap:2rem;flex-wrap:wrap">
        ${figure("Interest paid", p.metrics.interestPaid, "actual")}
        ${figure("Interest projected", p.metrics.interestProjected, "projected")}
        ${figure("If nothing had changed", p.metrics.baselineInterest, "projected")}
        ${figure("Interest saved", p.metrics.interestSaved, "projected")}
      </div>
      ${when(p.metrics.savedByRateMovement !== 0, () => html`
        <p class="field-hint">
          <!-- R22.4: a rate cut is not the household's achievement. -->
          Of that, ${formatPaise(p.metrics.savedByAction)} came from what you did —
          extra payments and prepayments — and
          ${formatPaise(p.metrics.savedByRateMovement)} from the rate moving.
        </p>
      `)}
      <p class="field-hint">
        ${p.metrics.progressPercent.toFixed(1)}% of the principal is repaid.
        ${when(p.metrics.emisSaved > 0 && p.outstanding > 0, () => html`
          You are ${p.metrics.emisSaved} instalments ahead of the original schedule.
        `)}
      </p>
    </section>

    ${when(opts.disbursements.length > 0, () => html`
      <section class="card">
        <h2>Disbursements</h2>
        ${opts.disbursements.map(
          (d) => html`
            <div class="row-between" style="padding:.5rem 0;border-top:1px solid var(--border)">
              <div>
                <strong>${formatPaise(d.amount)}</strong>
                <span class="faint"> · ${formatDate(d.date)}</span>
                <div class="faint">
                  ${d.destination === "third-party"
                    ? "Paid directly to a third party — never entered your budget"
                    : "Credited to an account — arrived as money to assign"}
                </div>
              </div>
            </div>
          `,
        )}
      </section>
    `)}

    ${when(p.undrawn > 0, () => html`
      <section class="card">
        <h2>Record a disbursement</h2>
        <p class="faint" style="margin-top:-.25rem">
          ${formatPaise(p.undrawn)} of the sanction is still undrawn. A tranche
          paid to a builder or dealer raises what you owe but never touches your
          budget; one credited to your account arrives as money to assign (R15).
        </p>
        <form method="post" action="/loans/${loan.id}/disburse">
          <div class="grid-2">
            <div class="field">
              <label for="d-amount">Amount</label>
              <input id="d-amount" name="amount" class="amount-input" type="text"
                     inputmode="decimal" required>
            </div>
            <div class="field">
              <label for="d-date">Date</label>
              <input id="d-date" name="date" placeholder="Today">
            </div>
          </div>
          <div class="field">
            <label for="d-dest">Where did it go?</label>
            <select id="d-dest" name="destination"
                    data-reveal="d-acct-field" data-reveal-when="budget-account">
              <option value="third-party">Paid directly to a third party (builder, dealer, institution)</option>
              <option value="budget-account">Credited to one of my accounts</option>
            </select>
          </div>
          <div class="field" id="d-acct-field" style="display:none">
            <label for="d-acct">Into which account?</label>
            <select id="d-acct" name="destination_account_id">
              ${opts.budgetAccounts.map((a) => html`<option value="${a.id}">${a.name}</option>`)}
            </select>
          </div>
          <button class="button-primary" type="submit">Record it</button>
        </form>
      </section>
    `)}

    ${when(opts.rates.length > 1, () => html`
      <section class="card">
        <h2>Rate history</h2>
        ${opts.rates.map(
          (r) => html`
            <div class="row-between" style="padding:.4rem 0;border-top:1px solid var(--border)">
              <span>${r.annual_rate_pct}%</span>
              <span class="faint">from ${formatDate(r.effective_from)}</span>
            </div>
          `,
        )}
      </section>
    `)}

    <section class="card">
      <h2>Payments</h2>
      ${opts.payments.length === 0
        ? html`<p class="faint">Nothing recorded yet.</p>`
        : html`
            <div class="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Date</th>
                    <th scope="col" class="num">Paid</th>
                    <th scope="col" class="num">Principal</th>
                    <th scope="col" class="num">Interest</th>
                    <th scope="col">Kind</th>
                  </tr>
                </thead>
                <tbody>
                  ${opts.payments.map(
                    (payment) => html`
                      <tr>
                        <td>${formatDate(payment.date)}</td>
                        <td class="num amount">${formatPaise(payment.amount)}</td>
                        <td class="num amount">
                          ${formatPaise(payment.principal)}
                          ${when(payment.estimated === 1, () => html`
                            <!-- R18.3: estimated splits are distinct everywhere. -->
                            <span class="chip chip-warning">estimated</span>
                          `)}
                        </td>
                        <td class="num amount">${formatPaise(payment.interest)}</td>
                        <td>${payment.kind}</td>
                      </tr>
                    `,
                  )}
                </tbody>
              </table>
            </div>
          `}
    </section>

    ${renderSchedule(p.schedule, loan.id)}
  `;
}

/** R17.2 · The schedule viewable in full, not just summarised, and exportable. */
function renderSchedule(schedule: Schedule, loanId: string): SafeHtml {
  if (schedule.instalments.length === 0) return raw("");
  return html`
    <section class="card">
      <div class="row-between">
        <h2>Projected schedule</h2>
        <a class="button button-small" href="/loans/${loanId}/schedule.csv">Export CSV</a>
      </div>
      <p class="faint" style="margin-top:-.25rem">
        ${schedule.months} instalments to closure, ${formatCompact(schedule.totalInterest)} of
        interest still to pay. Every row is projected until the lender confirms it.
      </p>
      <div class="table-scroll" style="max-height:24rem;overflow-y:auto">
        <table>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Due</th>
              <th scope="col" class="num">Opening</th>
              <th scope="col" class="num">Instalment</th>
              <th scope="col" class="num">Principal</th>
              <th scope="col" class="num">Interest</th>
              <th scope="col" class="num">Closing</th>
            </tr>
          </thead>
          <tbody>
            ${schedule.instalments.slice(0, 360).map(
              (i) => html`
                <tr>
                  <td>${i.number}</td>
                  <td>${i.dueDate ? formatDate(i.dueDate) : "—"}</td>
                  <td class="num amount">${formatPaise(i.opening)}</td>
                  <td class="num amount">${formatPaise(i.payment)}</td>
                  <td class="num amount">${formatPaise(i.principal)}</td>
                  <td class="num amount">${formatPaise(i.interest)}</td>
                  <td class="num amount">${formatPaise(i.closing)}</td>
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
// R19 · The prepayment comparison — the centrepiece
// ---------------------------------------------------------------------------

export function renderPrepaymentComparison(opts: {
  comparison: PrepaymentComparison;
  loan?: Loan | null;
  amount: Paise;
  atMonth: number;
  action: string;
  /** R19.4: a lump sum cannot silently drain envelopes. */
  fundingSources?: { id: string; name: string; balance: Paise }[];
  emergencyFundWarning?: string | null;
}): SafeHtml {
  const c = opts.comparison;

  return html`
    <h1>${opts.loan ? `Prepay ${opts.loan.nickname || opts.loan.lender}` : "What would a prepayment buy?"}</h1>

    <div class="card">
      <form method="post" action="${opts.action}" data-no-retry="true">
        <input type="hidden" name="preview" value="1">
        <div class="grid-2">
          <div class="field">
            <label for="amount">Prepayment</label>
            <input id="amount" name="amount" class="amount-input" type="text" inputmode="decimal"
                   value="${(opts.amount / 100).toFixed(2)}">
          </div>
          <div class="field">
            <label for="at_month">At instalment number</label>
            <input id="at_month" name="at_month" type="number" min="1" value="${opts.atMonth}">
          </div>
        </div>
        ${when(!opts.loan, () => html`
          <div class="grid-2">
            <div class="field">
              <label for="principal">Loan amount</label>
              <input id="principal" name="principal" class="amount-input" type="text" inputmode="decimal" required>
            </div>
            <div class="field">
              <label for="rate">Rate (% per year)</label>
              <input id="rate" name="rate" type="text" inputmode="decimal" required>
            </div>
          </div>
          <div class="field">
            <label for="months">Tenure in months</label>
            <input id="months" name="months" type="number" min="1" required>
          </div>
        `)}
        <button type="submit">Recalculate</button>
      </form>
    </div>

    <!-- R19.2: both outcomes side by side, before anything is committed. -->
    <div class="card">
      <h2>What this buys</h2>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col"></th>
              <th scope="col" class="num">Reduce the tenure <span class="chip chip-positive">default</span></th>
              <th scope="col" class="num">Reduce the EMI</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">Instalment after</th>
              <td class="num amount">${formatPaise(c.reduceTenure.emiAfter)} <span class="faint">unchanged</span></td>
              <td class="num amount">${formatPaise(c.reduceEmi.emiAfter)}</td>
            </tr>
            <tr>
              <th scope="row">Instalments left</th>
              <td class="num">${c.reduceTenure.months} <span class="faint">−${c.reduceTenure.emisSaved}</span></td>
              <td class="num">${c.reduceEmi.months} <span class="faint">unchanged</span></td>
            </tr>
            <tr>
              <th scope="row">Lifetime interest</th>
              <td class="num amount">${formatPaise(c.reduceTenure.lifetimeInterest)}</td>
              <td class="num amount">${formatPaise(c.reduceEmi.lifetimeInterest)}</td>
            </tr>
            <tr>
              <th scope="row">Interest saved</th>
              <td class="num amount amount-positive"><strong>${formatPaise(c.reduceTenure.interestSaved)}</strong></td>
              <td class="num amount amount-positive">${formatPaise(c.reduceEmi.interestSaved)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- R19.3: the reason, in one line, with the household's own numbers. -->
      <p class="notice notice-success" style="margin-top:1rem">${c.recommendation}</p>

      ${when(opts.emergencyFundWarning, () => html`
        <!-- R19.6: warn, never block (P2). -->
        <p class="notice notice-warning">${opts.emergencyFundWarning}</p>
      `)}
    </div>

    ${when(opts.loan, () => html`
      <form method="post" action="${opts.action}" class="card">
        <input type="hidden" name="amount" value="${(opts.amount / 100).toFixed(2)}">
        <input type="hidden" name="at_month" value="${opts.atMonth}">

        <div class="field">
          <label for="mode">How should it be applied?</label>
          <select id="mode" name="mode">
            <option value="tenure" selected>
              Reduce the tenure — close ${c.reduceTenure.emisSaved} instalments early
            </option>
            <option value="emi">
              Reduce the EMI — pay ${formatPaise(c.reduceTenure.emiAfter - c.reduceEmi.emiAfter)} less each month
            </option>
          </select>
        </div>

        ${when(opts.fundingSources && opts.fundingSources.length > 0, () => html`
          <div class="field">
            <label for="funding">Where is the money coming from?</label>
            <select id="funding" name="funding_category_id">
              <option value="">Ready to Assign</option>
              ${opts.fundingSources!.map(
                (s) => html`<option value="${s.id}">${s.name} — ${formatPaise(s.balance)}</option>`,
              )}
            </select>
            <p class="field-hint">
              A lump sum this size cannot come out of nowhere — say where, so no
              envelope is quietly drained.
            </p>
          </div>
        `)}

        <div class="field">
          <label for="charge">Prepayment charge <span class="faint">(if any)</span></label>
          <input id="charge" name="charge" class="amount-input" type="text" inputmode="decimal" placeholder="0.00">
        </div>

        <button class="button-primary" type="submit">Record this prepayment</button>
        <a class="button button-quiet" href="/loans/${opts.loan!.id}">Cancel</a>
      </form>
    `)}
  `;
}

// ---------------------------------------------------------------------------
// R20 · Rate reset
// ---------------------------------------------------------------------------

export function renderRateReset(opts: {
  loan: Loan;
  options: RateResetOptions;
  effectiveFrom: IsoDate;
}): SafeHtml {
  const o = opts.options;
  return html`
    <h1>Rate change · ${opts.loan.nickname || opts.loan.lender}</h1>
    <p class="muted">
      ${o.oldRatePct}% → ${o.newRatePct}% on an outstanding balance of
      ${formatPaise(o.outstanding)}.
    </p>

    <div class="card">
      <h2>Your options</h2>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Option</th>
              <th scope="col" class="num">Instalment</th>
              <th scope="col" class="num">Instalments left</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">Keep the instalment, let the tenure move</th>
              <td class="num amount">${formatPaise(o.keepEmi.emi)}</td>
              <td class="num">
                ${o.keepEmi.months}
                <span class="faint">${o.keepEmi.monthsDelta >= 0 ? "+" : ""}${o.keepEmi.monthsDelta}</span>
              </td>
            </tr>
            <tr>
              <th scope="row">Keep the tenure, let the instalment move</th>
              <td class="num amount">
                ${formatPaise(o.keepTenure.emi)}
                <span class="faint">${o.keepTenure.emiDelta >= 0 ? "+" : ""}${formatPaise(o.keepTenure.emiDelta)}</span>
              </td>
              <td class="num">${o.keepTenure.months}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="field-hint">
        Lenders are required to offer both, plus switching to a fixed rate and
        prepaying. Whichever you pick, the instalment must always cover the
        month's interest.
      </p>
    </div>

    <!--
      B71 · This comparison was built and rendered by nobody: recordRateChange
      existed, rateResetOptions existed, this component existed, and no route
      tied them together. A repo-linked home loan resets several times a year,
      so the app modelled the most common event in an Indian loan and offered no
      way to enter it.
    -->
    <form method="post" action="/loans/${opts.loan.id}/rate" class="card">
      <h2>Record it</h2>
      <div class="grid-2">
        <div class="field">
          <label for="rate-new">New rate (% a year)</label>
          <input id="rate-new" name="annual_rate_pct" inputmode="decimal" required
                 value="${o.newRatePct}">
        </div>
        <div class="field">
          <label for="rate-from">Effective from</label>
          <input id="rate-from" name="effective_from" placeholder="DD-MM-YYYY" required
                 value="${formatDate(opts.effectiveFrom)}">
        </div>
      </div>
      <div class="field">
        <label for="rate-note">Note (optional)</label>
        <input id="rate-note" name="note" placeholder="Repo rate cut, letter dated 3 Sept">
      </div>
      <p class="field-hint">
        Recording the change re-derives the schedule from that date. What you
        actually owe does not change — only how the remaining instalments split.
      </p>
      <button class="button-primary" type="submit">Record the rate change</button>
    </form>
  `;
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

export function renderNewLoanForm(opts: {
  members?: { id: string; name: string }[];
  accounts: { id: string; name: string }[];
  error?: string | null;
}): SafeHtml {
  return html`
    <h1>Add a loan</h1>
    ${when(opts.error, () => html`<p class="notice notice-error">${opts.error}</p>`)}

    <form method="post" action="/loans/new" class="card">
      ${renderHolderFields(opts.members ?? [])}
      <div class="grid-2">
        <div class="field">
          <label for="lender">Lender</label>
          <input id="lender" name="lender" required placeholder="Axis Bank">
        </div>
        <div class="field">
          <label for="nickname">What you call it <span class="faint">(optional)</span></label>
          <input id="nickname" name="nickname" placeholder="Personal loan">
        </div>
      </div>

      <div class="field">
        <label for="loan_type">Type</label>
        <select id="loan_type" name="loan_type" required>
          ${Object.entries(LOAN_TYPE_LABELS).map(
            ([value, label]) => html`<option value="${value}">${label}</option>`,
          )}
        </select>
      </div>

      <fieldset>
        <legend>How the interest is charged</legend>
        <div class="field">
          <label for="interest_model">Interest model</label>
          <select id="interest_model" name="interest_model" required
                  data-reveal="moratorium-field" data-reveal-when="moratorium" data-reveal-prefix>
            <option value="reducing">Reducing balance — interest on what you still owe</option>
            <option value="flat">Flat rate — interest on the original amount, for the whole term</option>
            <option value="moratorium-serviced">Moratorium, interest serviced — pay interest during, principal later</option>
            <option value="moratorium-capitalised">Moratorium, interest capitalised — pay nothing during, it rolls into principal</option>
          </select>
          <p class="field-hint">
            <strong>Check your sanction letter.</strong> Personal, car and gold loans
            are often quoted flat, and a flat rate is close to double what it sounds
            like — 9% flat is about 15.7% in reducing-balance terms. A moratorium is
            common on education loans and under-construction homes: servicing the
            interest keeps the principal flat, while capitalising it rolls the unpaid
            interest into what you owe — far more expensive, and worth seeing before
            you choose it.
          </p>
        </div>
        <div class="field" id="moratorium-field" style="display:none">
          <label for="moratorium_months">Moratorium length in months</label>
          <input id="moratorium_months" name="moratorium_months" type="text"
                 inputmode="numeric" placeholder="e.g. 48">
        </div>
      </fieldset>

      <div class="grid-2">
        <div class="field">
          <label for="sanctioned">Sanctioned amount</label>
          <input id="sanctioned" name="sanctioned" class="amount-input" type="text" inputmode="decimal" required>
        </div>
        <div class="field">
          <label for="annual_rate">Rate (% per year)</label>
          <input id="annual_rate" name="annual_rate" type="text" inputmode="decimal" required placeholder="8.5">
        </div>
      </div>

      <div class="grid-2">
        <div class="field">
          <label for="tenure_months">Tenure in months</label>
          <input id="tenure_months" name="tenure_months" type="number" min="1" required>
        </div>
        <div class="field">
          <label for="sanction_date">Sanctioned on</label>
          <input id="sanction_date" name="sanction_date" type="text" placeholder="DD-MM-YYYY">
        </div>
      </div>

      <fieldset>
        <legend>Already part-way through?</legend>
        <div class="grid-2">
          <div class="field">
            <label for="current_outstanding">What you owe today</label>
            <input id="current_outstanding" name="current_outstanding" class="amount-input"
                   type="text" inputmode="decimal">
          </div>
          <div class="field">
            <label for="history_from">History known from</label>
            <input id="history_from" name="history_from" type="text" placeholder="DD-MM-YYYY">
          </div>
        </div>
        <p class="field-hint">
          If you don't have the full history, lifetime figures will be labelled
          "from" that date rather than presented as complete.
        </p>
      </fieldset>

      <div class="grid-2">
        <div class="field">
          <label for="first_instalment_date">First instalment due</label>
          <input id="first_instalment_date" name="first_instalment_date" type="text" placeholder="DD-MM-YYYY">
        </div>
        <div class="field">
          <label for="repayment_account_id">Paid from</label>
          <select id="repayment_account_id" name="repayment_account_id">
            <option value="">Choose later</option>
            ${opts.accounts.map((a) => html`<option value="${a.id}">${a.name}</option>`)}
          </select>
        </div>
      </div>

      <button class="button-primary" type="submit">Add the loan</button>
    </form>
  `;
}

export function renderRecordInstalment(opts: {
  projection: LoanProjection;
  accounts: { id: string; name: string }[];
  today: IsoDate;
}): SafeHtml {
  const p = opts.projection;
  const next = p.schedule.instalments[0];

  return html`
    <h1>Record an instalment</h1>
    <p class="muted">${p.loan.nickname || p.loan.lender} · ${formatPaise(p.outstanding)} outstanding</p>

    ${when(next, () => html`
      <p class="notice notice-info">
        The projection expects ${formatPaise(next!.payment)} —
        ${formatPaise(next!.principal)} principal and ${formatPaise(next!.interest)} interest.
        Enter the lender's own split if you have it; otherwise this one is used and
        marked estimated until confirmed.
      </p>
    `)}

    <form method="post" action="/loans/${p.loan.id}/pay" class="card">
      <div class="grid-2">
        <div class="field">
          <label for="amount">Amount paid</label>
          <input id="amount" name="amount" class="amount-input" type="text" inputmode="decimal"
                 required value="${next ? (next.payment / 100).toFixed(2) : ""}">
        </div>
        <div class="field">
          <label for="date">Date</label>
          <input id="date" name="date" type="text" value="${formatDate(opts.today)}">
        </div>
      </div>

      <fieldset>
        <legend>The lender's split <span class="faint">(optional)</span></legend>
        <div class="grid-2">
          <div class="field">
            <label for="principal">Principal</label>
            <input id="principal" name="principal" class="amount-input" type="text" inputmode="decimal">
          </div>
          <div class="field">
            <label for="interest">Interest</label>
            <input id="interest" name="interest" class="amount-input" type="text" inputmode="decimal">
          </div>
        </div>
        <p class="field-hint">
          Leave these blank to use the projection. The lender's figures are always
          authoritative where you have them.
        </p>
      </fieldset>

      <div class="field">
        <label for="from_account_id">Paid from</label>
        <select id="from_account_id" name="from_account_id">
          <option value="">Don't record a transfer</option>
          ${opts.accounts.map(
            (a) => html`
              <option value="${a.id}" ${raw(a.id === p.loan.repayment_account_id ? "selected" : "")}>
                ${a.name}
              </option>
            `,
          )}
        </select>
      </div>

      <button class="button-primary" type="submit">Record it</button>
      <a class="button button-quiet" href="/loans/${p.loan.id}">Cancel</a>
    </form>
  `;
}

/**
 * B51 · Record a lender's statement to resolve drift (R18.8).
 *
 * The drift warning's "Resolve it" link pointed at `/loans/:id/statement`,
 * which had no route. `recordLoanStatement` already existed — this is the form
 * it needed. Entering the lender's own outstanding recomputes the drift.
 */
export function renderLoanStatementForm(opts: {
  projection: LoanProjection;
  today: IsoDate;
}): SafeHtml {
  const p = opts.projection;
  return html`
    <h1>Record a lender statement</h1>
    <p class="muted">${p.loan.nickname || p.loan.lender}</p>
    <p class="notice notice-info">
      This app currently computes <strong>${formatPaise(p.outstanding)}</strong> outstanding.
      Enter what the lender's latest statement says, and the difference (if any) is shown
      as drift with its likely causes — a mid-cycle rate reset, part-month interest, fees
      added to principal, or a value-date difference.
    </p>
    <form method="post" action="/loans/${p.loan.id}/statement" class="card">
      <div class="grid-2">
        <div class="field">
          <label for="lender_outstanding">Lender's outstanding</label>
          <input id="lender_outstanding" name="lender_outstanding" class="amount-input"
                 type="text" inputmode="decimal" autocomplete="off" required autofocus
                 placeholder="0.00">
        </div>
        <div class="field">
          <label for="as_of">Statement date</label>
          <input id="as_of" name="as_of" type="text" autocomplete="off"
                 value="${formatDate(opts.today)}" placeholder="DD-MM-YYYY">
        </div>
      </div>
      <fieldset>
        <legend>If the statement shows them <span class="faint">(optional)</span></legend>
        <div class="grid-2">
          <div class="field">
            <label for="interest_paid_ytd">Interest paid this financial year</label>
            <input id="interest_paid_ytd" name="interest_paid_ytd" class="amount-input"
                   type="text" inputmode="decimal" autocomplete="off">
          </div>
          <div class="field">
            <label for="instalments_remaining">Instalments remaining</label>
            <input id="instalments_remaining" name="instalments_remaining" type="text"
                   inputmode="numeric" autocomplete="off">
          </div>
        </div>
      </fieldset>
      <button class="button-primary" type="submit">Record statement</button>
      <a class="button button-quiet" href="/loans/${p.loan.id}">Cancel</a>
    </form>
  `;
}
