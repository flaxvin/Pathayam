/**
 * The tax estimate screen.
 *
 * Reverses `02` N15 deliberately (decisions log Q31), and the whole design of
 * this page is about making that reversal safe. It shows both regimes side by
 * side, every figure that went into each, and — prominently, not in a footer —
 * what it does not model. An estimate that hides its own limits is the kind
 * that gets trusted past them.
 */

import { html, type SafeHtml } from "../../http/html.ts";
import { formatPaise, type Paise } from "../../core/money.ts";
import { formatFiscalYear } from "../../core/dates.ts";
import type { TaxEstimate, RegimeEstimate, Deductions, AdvanceInstalment } from "../../domain/tax.ts";

export interface TaxPageProps {
  fy: number;
  gross: Paise;
  /** What the ledger has, before the person overrode it. */
  ledgerIncome: Paise;
  deductions: Deductions;
  estimate: TaxEstimate | null;
  advance: AdvanceInstalment[];
  staleWarning: string | null;
  ratesVerifiedOn: string;
  ratesSource: string;
  availableYears: number[];
}

function row(label: string, value: Paise, opts: { muted?: boolean; strong?: boolean } = {}): SafeHtml {
  return html`
    <tr>
      <td class="${opts.muted ? "faint" : ""}">${opts.strong ? html`<strong>${label}</strong>` : label}</td>
      <td class="amount">
        ${opts.strong ? html`<strong>${formatPaise(value)}</strong>` : formatPaise(value)}
      </td>
    </tr>
  `;
}

function regimeCard(e: RegimeEstimate, isBetter: boolean): SafeHtml {
  return html`
    <div class="card" style="${isBetter ? "border-color:var(--good)" : ""}">
      <h3>
        ${e.regime === "new" ? "New regime" : "Old regime"}
        ${isBetter ? html`<span class="pill pill-good">Lower</span>` : html``}
      </h3>
      <p class="amount" style="font-size:1.6rem;margin:.25rem 0">
        <strong>${formatPaise(e.total)}</strong>
      </p>
      <p class="faint">${e.effectiveRatePct}% of gross</p>
      <div class="table-scroll">
        <table>
          <tbody>
            ${row("Gross income", e.gross)}
            ${row("Standard deduction", -e.standardDeduction as Paise, { muted: true })}
            ${e.hraExempt > 0 ? row("HRA exempt", -e.hraExempt as Paise, { muted: true }) : html``}
            ${e.chapterViA > 0 ? row("80C, 80D and other", -e.chapterViA as Paise, { muted: true }) : html``}
            ${row("Taxable income", e.taxable, { strong: true })}
            ${row("Tax on slabs", e.taxBeforeRebate)}
            ${e.rebate > 0 ? row("Section 87A rebate", -e.rebate as Paise, { muted: true }) : html``}
            ${e.surcharge > 0 ? row("Surcharge", e.surcharge) : html``}
            ${row("Health and education cess", e.cess)}
            ${row("Total", e.total, { strong: true })}
          </tbody>
        </table>
      </div>
      ${e.regime === "new" && (e.chapterViA === 0)
        ? html`<p class="field-hint">The new regime allows no 80C, 80D or HRA. Anything entered is ignored here, by design.</p>`
        : html``}
    </div>
  `;
}

export function renderTax(p: TaxPageProps): SafeHtml {
  const d = p.deductions;
  return html`
    <h1>Tax estimate · ${formatFiscalYear(p.fy)}</h1>

    <div class="notice notice-warning">
      <strong>An estimate, not a return, and not advice.</strong>
      This is arithmetic on the figures below, under the slabs as last checked on
      ${p.ratesVerifiedOn}. It is not a computation of what you owe, it does not
      file anything, and it is not a substitute for an accountant. Check anything
      that matters against
      <a href="${p.ratesSource}" rel="noopener noreferrer" target="_blank">the department</a>.
    </div>

    ${p.staleWarning
      ? html`<div class="notice notice-danger"><strong>Rates may be out of date.</strong> ${p.staleWarning}</div>`
      : html``}

    <form class="card" method="get" action="/tax">
      <div class="row" style="gap:1rem;align-items:flex-end;flex-wrap:wrap">
        <div class="field" style="margin:0">
          <label for="fy">Financial year</label>
          <select id="fy" name="fy">
            ${p.availableYears.map((y) => html`
              <option value="${y}" ${y === p.fy ? "selected" : ""}>${formatFiscalYear(y)}</option>
            `)}
          </select>
        </div>
        <button type="submit">Change year</button>
      </div>
    </form>

    ${p.estimate
      ? html`
          <div class="cards-2">
            ${regimeCard(p.estimate.old, p.estimate.better === "old")}
            ${regimeCard(p.estimate.new, p.estimate.better === "new")}
          </div>
          <p class="lede">
            ${p.estimate.better === null
              ? html`The two come to the same figure.`
              : html`
                  The <strong>${p.estimate.better === "new" ? "new" : "old"} regime</strong>
                  is lower by <strong>${formatPaise(p.estimate.saves)}</strong> on these
                  numbers.
                `}
          </p>
        `
      : html`<p class="muted">Enter a gross income to see an estimate.</p>`}

    <form class="card" method="post" action="/tax">
      <h2>What it is working from</h2>
      <input type="hidden" name="fy" value="${p.fy}">

      <div class="field">
        <label for="gross">Gross income for the year</label>
        <input id="gross" name="gross" inputmode="decimal" value="${(p.gross / 100).toFixed(2)}">
        <p class="field-hint">
          Your ledger shows ${formatPaise(p.ledgerIncome)} of income in this
          financial year across accounts you can see. That is money that arrived,
          which is not the same as taxable salary — it misses anything paid into
          an account this app does not hold, and it includes receipts that are
          not income at all. Correct it here; this figure is what the estimate
          uses.
        </p>
      </div>

      <h3>Deductions</h3>
      <p class="faint">
        These apply under the old regime only. The new regime ignores them, which
        is the trade the comparison above is showing you.
      </p>

      <div class="field">
        <label for="s80c">Section 80C</label>
        <input id="s80c" name="s80c" inputmode="decimal" value="${(d.s80c / 100).toFixed(2)}">
        <p class="field-hint">PF, ELSS, life premium, home loan principal, tuition. Capped at ₹1,50,000.</p>
      </div>

      <div class="field">
        <label for="s80d">Section 80D</label>
        <input id="s80d" name="s80d" inputmode="decimal" value="${(d.s80d / 100).toFixed(2)}">
        <label class="row" style="gap:.5rem;margin-top:.5rem">
          <input type="checkbox" name="s80d_senior" value="1" ${d.s80dSenior ? "checked" : ""}>
          A senior citizen is covered
        </label>
        <p class="field-hint">Health insurance premiums. ₹25,000, or ₹50,000 where a senior citizen is covered.</p>
      </div>

      <div class="field">
        <label for="other">Other deductions</label>
        <input id="other" name="other" inputmode="decimal" value="${(d.other / 100).toFixed(2)}">
        <p class="field-hint">
          Anything else you claim — 80CCD(1B), 80TTA, 80G, and home loan interest
          under section 24(b), which is often the largest of them. Entered as one
          figure because this app does not know which is which.
        </p>
      </div>

      <h3>House rent allowance</h3>
      <p class="faint">
        Exempt to the least of three: the HRA received, rent paid less 10% of
        basic, and half of basic in a metro (40% elsewhere). Leave the rent at
        zero if you do not pay any — no rent exempts nothing, whatever the HRA.
      </p>
      <div class="row" style="gap:1rem;flex-wrap:wrap">
        <div class="field">
          <label for="hra_received">HRA received</label>
          <input id="hra_received" name="hra_received" inputmode="decimal"
                 value="${((d.hra?.received ?? 0) / 100).toFixed(2)}">
        </div>
        <div class="field">
          <label for="hra_rent">Rent paid</label>
          <input id="hra_rent" name="hra_rent" inputmode="decimal"
                 value="${((d.hra?.rentPaid ?? 0) / 100).toFixed(2)}">
        </div>
        <div class="field">
          <label for="hra_basic">Basic + DA</label>
          <input id="hra_basic" name="hra_basic" inputmode="decimal"
                 value="${((d.hra?.basic ?? 0) / 100).toFixed(2)}">
        </div>
      </div>
      <label class="row" style="gap:.5rem">
        <input type="checkbox" name="hra_metro" value="1" ${d.hra?.metro ? "checked" : ""}>
        Delhi, Mumbai, Kolkata or Chennai
      </label>

      <button class="button-primary" type="submit" style="margin-top:1rem">Save and recalculate</button>
    </form>

    ${p.advance.length > 0
      ? html`
          <section class="card">
            <h2>Advance tax</h2>
            <p>
              On ${formatPaise(p.estimate!.better === "old" ? p.estimate!.old.total : p.estimate!.new.total)},
              section 211 asks for it in four instalments. Missing one costs
              interest under 234B and 234C, which is the only reason these dates
              are worth knowing in advance.
            </p>
            <div class="table-scroll">
              <table>
                <thead>
                  <tr><th>Due</th><th>Cumulative</th><th class="amount">By then</th><th class="amount">This instalment</th></tr>
                </thead>
                <tbody>
                  ${p.advance.map((i) => html`
                    <tr>
                      <td>${i.label} ${i.date.slice(0, 4)}</td>
                      <td>${i.cumulativePct}%</td>
                      <td class="amount">${formatPaise(i.cumulativeAmount)}</td>
                      <td class="amount">${formatPaise(i.instalmentAmount)}</td>
                    </tr>
                  `)}
                </tbody>
              </table>
            </div>
            <p class="field-hint">
              Figures are on the estimate above and take no account of tax already
              deducted at source, which for most salaried people covers all of it.
            </p>
          </section>
        `
      : html``}

    <section class="card">
      <h2>What this does not do</h2>
      <p>
        Each of these changes the answer, and none of them is here. The list is
        on the screen rather than in a footnote because an estimate that hides
        what it ignores is one that gets trusted too far.
      </p>
      <ul class="checks">
        <li><strong>Marginal relief</strong> on surcharge, and on the 87A cliff — so a figure just over a threshold is overstated.</li>
        <li><strong>Capital gains</strong>, which are taxed at their own rates rather than at slab rates.</li>
        <li><strong>Tax already deducted at source.</strong> Nothing here is netted against your Form 16 or 26AS.</li>
        <li><strong>Losses</strong> set off or carried forward, house property loss, and clubbing.</li>
        <li><strong>Anything foreign</strong> — income, assets, or relief under a treaty.</li>
        <li><strong>Presumptive schemes</strong> under 44AD or 44ADA.</li>
      </ul>
    </section>
  `;
}
