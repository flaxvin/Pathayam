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
import { formatFiscalYear, formatDate } from "../../core/dates.ts";
import type {
  TaxEstimate, RegimeEstimate, Deductions, AdvanceInstalment, TaxPayment, TaxPaid, Settlement,
} from "../../domain/tax.ts";
import type { GainsTax } from "../../domain/capital-gains-tax.ts";
import type { HomeLoanInterest } from "../../domain/home-loan-interest.ts";

export interface TaxPageProps {
  fy: number;
  gross: Paise;
  /** What the ledger has, before the person overrode it. */
  ledgerIncome: Paise;
  deductions: Deductions;
  estimate: TaxEstimate | null;
  advance: AdvanceInstalment[];
  gains: GainsTax;
  staleWarning: string | null;
  ratesVerifiedOn: string;
  ratesSource: string;
  availableYears: number[];
  /** TAX-1 · Home loan interest the ledger accrued in the year, loan by loan. */
  homeLoan: HomeLoanInterest;
  /** The person's own 24(b) figure, or null to use the ledger's. */
  s24bOverride: Paise | null;
  /** TAX-2 · Advance and self-assessment tax paid, and the totals. */
  payments: TaxPayment[];
  paid: TaxPaid;
  settlement: { old: Settlement; new: Settlement } | null;
  /** TAX-3 · The year's advance-tax threshold. */
  advanceThreshold: Paise;
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
      <p class="faint">${e.effectiveRatePct}% of income, gains included</p>
      <div class="table-scroll">
        <table>
          <tbody>
            ${row("Gross income", e.gross)}
            ${e.standardDeduction > 0 ? row("Standard deduction", -e.standardDeduction as Paise, { muted: true }) : html``}
            ${e.hraExempt > 0 ? row("HRA exempt", -e.hraExempt as Paise, { muted: true }) : html``}
            ${e.homeLoanInterest > 0 ? row("Home loan interest, s24(b)", -e.homeLoanInterest as Paise, { muted: true }) : html``}
            ${e.chapterViA > 0 ? row("80C, 80D and other", -e.chapterViA as Paise, { muted: true }) : html``}
            ${row("Taxable income", e.taxable, { strong: true })}
            ${row("Tax on slabs", e.taxBeforeRebate)}
            ${e.rebate > 0 ? row("Section 87A rebate", -e.rebate as Paise, { muted: true }) : html``}
            ${e.specialRateTax > 0 ? row("Capital gains, at their own rates", e.specialRateTax) : html``}
            ${e.surcharge > 0 ? row("Surcharge", e.surcharge) : html``}
            ${row("Health and education cess", e.cess)}
            ${row("Total", e.total, { strong: true })}
          </tbody>
        </table>
      </div>
      ${e.regime === "new" && (e.chapterViA === 0)
        ? html`<p class="field-hint">The new regime allows no 80C, 80D, HRA or interest on a home you live in. Anything entered is ignored here, by design.</p>`
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
      ${formatDate(p.ratesVerifiedOn)}. It is not a computation of what you owe, it does not
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
        <label for="s80d">Section 80D — yourself, spouse and children</label>
        <input id="s80d" name="s80d" inputmode="decimal" value="${(d.s80d / 100).toFixed(2)}">
        <label for="s80d_checkup" class="faint">Preventive health check-ups for them</label>
        <input id="s80d_checkup" name="s80d_checkup" inputmode="decimal" value="${((d.s80dCheckup ?? 0) / 100).toFixed(2)}">
        <label class="row" style="gap:.5rem;margin-top:.5rem">
          <input type="checkbox" name="s80d_senior" value="1" ${d.s80dSenior ? "checked" : ""}>
          One of them is a senior citizen
        </label>
        <p class="field-hint">
          Health insurance premiums. ₹25,000, or ₹50,000 where one of them is a senior
          citizen (whose medical bills count, if they are not insured).
        </p>
      </div>

      <div class="field">
        <label for="s80d_parents">Section 80D — parents</label>
        <input id="s80d_parents" name="s80d_parents" inputmode="decimal" value="${((d.s80dParents ?? 0) / 100).toFixed(2)}">
        <label for="s80d_parents_checkup" class="faint">Preventive health check-ups for them</label>
        <input id="s80d_parents_checkup" name="s80d_parents_checkup" inputmode="decimal" value="${((d.s80dParentsCheckup ?? 0) / 100).toFixed(2)}">
        <label class="row" style="gap:.5rem;margin-top:.5rem">
          <input type="checkbox" name="s80d_parents_senior" value="1" ${d.s80dParentsSenior ? "checked" : ""}>
          A parent is a senior citizen
        </label>
        <p class="field-hint">
          A second ceiling of its own: ₹25,000, or ₹50,000 where a parent is a senior
          citizen. For a senior parent with no insurance, their medical bills count
          here instead. Check-ups count up to ₹5,000 in all, inside these ceilings.
        </p>
      </div>

      <div class="field">
        <label for="other">Other deductions</label>
        <input id="other" name="other" inputmode="decimal" value="${(d.other / 100).toFixed(2)}">
        <p class="field-hint">
          Anything else you claim — 80CCD(1B), 80TTA, 80G. Entered as one figure
          because this app does not know which is which. Home loan interest is
          not one of them any more: it has its own line below.
        </p>
      </div>

      <h3>Home loan interest · section 24(b)</h3>
      ${homeLoanFields(p)}

      <h3>Tax deducted at source</h3>
      <div class="field">
        <label for="tds">TDS for the year</label>
        <input id="tds" name="tds" inputmode="decimal" value="${(p.paid.tds / 100).toFixed(2)}">
        <p class="field-hint">
          The total from your Form 16, or from 26AS where more than one employer
          or bank deducted. It is netted against the estimate below, and comes
          off before the advance-tax threshold is tested.
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

    ${(p.gains.buckets.equityLong || p.gains.buckets.equityShort || p.gains.buckets.otherLong
       || p.gains.buckets.slabRated || p.gains.buckets.unclassified)
      ? html`
          <section class="card">
            <h2>Capital gains</h2>
            <p>
              Taken from sales recorded in your portfolio this financial year.
              The rate depends on what was sold and how long it was held, so
              these are separated rather than totalled.
            </p>
            <div class="table-scroll">
              <table>
                <thead>
                  <tr><th>Head</th><th class="amount">Gain</th><th class="amount">Tax</th></tr>
                </thead>
                <tbody>
                  ${p.gains.buckets.equityLong !== 0 ? html`
                    <tr>
                      <td>
                        Listed equity, over 12 months <span class="faint">· s112A, 12.5%</span>
                        ${p.gains.exemptionUsed > 0
                          ? html`<br><span class="faint">less ${formatPaise(p.gains.exemptionUsed)} exempt</span>`
                          : html``}
                      </td>
                      <td class="amount">${formatPaise(p.gains.buckets.equityLong)}</td>
                      <td class="amount">${formatPaise(p.gains.equityLongTax)}</td>
                    </tr>` : html``}
                  ${p.gains.buckets.equityShort !== 0 ? html`
                    <tr>
                      <td>Listed equity, 12 months or less <span class="faint">· s111A, 20%</span></td>
                      <td class="amount">${formatPaise(p.gains.buckets.equityShort)}</td>
                      <td class="amount">${formatPaise(p.gains.equityShortTax)}</td>
                    </tr>` : html``}
                  ${p.gains.buckets.otherLong !== 0 ? html`
                    <tr>
                      <td>Gold, property or foreign shares, over 24 months <span class="faint">· s112, 12.5%</span></td>
                      <td class="amount">${formatPaise(p.gains.buckets.otherLong)}</td>
                      <td class="amount">${formatPaise(p.gains.otherLongTax)}</td>
                    </tr>` : html``}
                  ${p.gains.buckets.slabRated !== 0 ? html`
                    <tr>
                      <td>Debt, and short-held gold, property or foreign shares <span class="faint">· at your slab rate</span></td>
                      <td class="amount">${formatPaise(p.gains.buckets.slabRated)}</td>
                      <td class="amount faint">added to income above</td>
                    </tr>` : html``}
                </tbody>
              </table>
            </div>
            ${p.gains.buckets.unclassified !== 0
              ? html`
                  <div class="notice notice-warning">
                    <strong>${formatPaise(p.gains.buckets.unclassified)} could not be placed, and is not in the figures above.</strong>
                    Its rate depends on something this app does not know, and
                    guessing would put it in the wrong column at the wrong rate.
                    <ul>
                      ${p.gains.buckets.unclassifiedReasons.map((r) => html`
                        <li>${r.instrument} — ${formatPaise(r.gain)}: ${r.reason}</li>
                      `)}
                    </ul>
                    Setting the asset class on the
                    <a href="/portfolio">portfolio</a> resolves most of these.
                  </div>
                `
              : html``}
            <p class="field-hint">
              Listed equity bought before 1 February 2018 is taxed only on its
              gain since 31 January 2018, using the price recorded for that day.
            </p>
            <p class="field-hint">
              The ₹1,25,000 exemption is annual and applies only to long-held
              listed equity. It does not extend to short-term gains, to gold, or
              to property.
            </p>
            <p class="field-hint">
              The tax column is each gain on its own. The estimate above goes
              further: where your other income is below the basic exemption,
              the unused part is set against these gains first; the 87A
              ceiling and the surcharge band are tested on your income
              including them; and surcharge on them stops at 15%.
            </p>
          </section>
        `
      : html``}

    ${paidSection(p)}

    ${p.advance.length > 0
      ? html`
          <section class="card" id="advance">
            <h2>Advance tax</h2>
            <p>
              The ${p.estimate!.better === "old" ? "old" : "new"} regime's
              ${formatPaise(p.estimate!.better === "old" ? p.estimate!.old.total : p.estimate!.new.total)},
              less ${formatPaise(p.paid.tds)} deducted at source, leaves
              <strong>${formatPaise(p.advance.at(-1)!.cumulativeAmount)}</strong> — at or above
              the ${formatPaise(p.advanceThreshold)} at which advance tax is due. It is paid in
              four instalments, each a share of the year's whole.
            </p>
            <div class="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Due</th><th>Cumulative</th><th class="amount">Due by then</th>
                    <th class="amount">This instalment</th><th class="amount">Paid by then</th><th class="amount">Short</th>
                  </tr>
                </thead>
                <tbody>
                  ${p.advance.map((i) => html`
                    <tr>
                      <td>${formatDate(i.date)}</td>
                      <td>${i.cumulativePct}%</td>
                      <td class="amount">${formatPaise(i.cumulativeAmount)}</td>
                      <td class="amount">${formatPaise(i.instalmentAmount)}</td>
                      <td class="amount">${formatPaise(i.paidByThen)}</td>
                      <td class="amount">${i.shortBy > 0 ? formatPaise(i.shortBy) : html`<span class="faint">—</span>`}</td>
                    </tr>
                  `)}
                </tbody>
              </table>
            </div>
            <p class="field-hint">
              Paying late or short costs interest — under section 234C on each
              instalment, and under 234B if less than 90% is paid by the year's end.
              This app names them and does not work them out. A resident senior
              citizen with no business income owes no advance tax at all, and
              income under 44AD or 44ADA is paid in one instalment by 15 March;
              neither is modelled here.
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
        <li><strong>Losses set off between heads.</strong> A long-term loss can only go against a long-term gain, and this nets nothing — each bucket is floored at zero, so a year with losses is overstated.</li>
        <li><strong>Losses</strong> set off or carried forward, and clubbing. A let-out house's loss, and its rent, are not here at all.</li>
        <li><strong>Home loan interest beyond the plain case.</strong> Interest before a house is finished (claimed in five parts afterwards), the ₹30,000 limit on a loan taken before April 1999 or for repairs, and a joint loan's split between borrowers — each needs the figure entered by hand.</li>
        <li><strong>Interest for paying late or short</strong> — 234A, 234B and 234C — and the senior citizen's exemption from advance tax.</li>
        <li><strong>TDS line by line.</strong> It is one figure, as entered; nothing is read from Form 16 or 26AS.</li>
        <li><strong>Anything foreign</strong> beyond the gain on a sale — foreign income, dividends, Schedule FA, or relief under a treaty. A foreign share's gain is taxed as the Act taxes an unlisted one: slab rates up to 24 months, s112 after.</li>
        <li><strong>Presumptive schemes</strong> under 44AD or 44ADA.</li>
      </ul>
    </section>
  `;
}

/**
 * TAX-1 · What the ledger accrued, loan by loan, and the box to override it.
 */
function homeLoanFields(p: TaxPageProps): SafeHtml {
  const h = p.homeLoan;
  const selfOccupied = h.lines.filter((x) => x.use === "self-occupied");
  const letOut = h.lines.filter((x) => x.use === "let-out");
  return html`
    <p class="faint">
      Carried from your loans, now, rather than typed into "other deductions":
      interest accrued in ${formatFiscalYear(p.fy)} on a loan for a house you live
      in, old regime only, capped at ₹2,00,000 across every such house. Mark a loan
      as for a house on its own page.
    </p>
    ${h.lines.length > 0
      ? html`
          <div class="table-scroll">
            <table>
              <thead><tr><th>Loan</th><th>House</th><th class="amount">Accrued in the year</th><th></th></tr></thead>
              <tbody>
                ${h.lines.map((x) => html`
                  <tr>
                    <td><a href="/loans/${x.loanId}">${x.name}</a></td>
                    <td>${x.use === "self-occupied" ? "lived in" : "let out"}</td>
                    <td class="amount">
                      ${formatPaise(x.accrued)}
                      ${x.estimatedPart > 0 || x.incomplete
                        ? html`<span class="chip chip-warning">estimated</span>`
                        : html``}
                    </td>
                    <td class="faint">${x.carried ? "carried" : html`not carried: ${x.reason}`}</td>
                  </tr>
                `)}
              </tbody>
            </table>
          </div>
          ${selfOccupied.some((x) => x.estimatedPart > 0)
            ? html`<p class="field-hint">
                Estimated: ${formatPaise(selfOccupied.reduce((t, x) => t + x.estimatedPart, 0) as Paise)} of it
                is not the lender's own figure — an instalment whose split the app worked
                out, or one not yet recorded, taken from the projected schedule. The
                lender's interest certificate is the number for the return; enter it below.
              </p>`
            : html``}
          ${h.lines.some((x) => x.incomplete)
            ? html`<p class="field-hint">
                Some instalments in this year are not recorded, so their interest is
                missing and the figure is low. Record them, or enter the certificate's figure.
              </p>`
            : html``}
          ${letOut.length > 0
            ? html`<p class="field-hint">
                ${formatPaise(h.letOut)} on a let-out house is shown for information and
                not deducted: it is set against the rent, which this app does not model.
              </p>`
            : html``}
        `
      : html`<p class="muted">No loan held by you is marked as for a house you live in or let out.</p>`}
    <div class="field">
      <label for="s24b">Your own figure, if different</label>
      <input id="s24b" name="s24b" inputmode="decimal"
             value="${p.s24bOverride === null ? "" : (p.s24bOverride / 100).toFixed(2)}"
             placeholder="${(h.selfOccupied / 100).toFixed(2)}">
      <p class="field-hint">
        ${p.s24bOverride === null
          ? html`Blank uses the ${formatPaise(h.selfOccupied)} carried above.`
          : html`Your figure is used instead of the ${formatPaise(h.selfOccupied)} carried above. Clear it to go back.`}
        Accrued interest for the year, before the cap: the certificate's figure, or
        your share of a loan taken jointly.
      </p>
    </div>
  `;
}

/**
 * TAX-2 · Tax already paid, and what is left under each regime.
 */
function paidSection(p: TaxPageProps): SafeHtml {
  const line = (s: Settlement): SafeHtml => html`
    <tr>
      <td>${s.regime === "old" ? "Old regime" : "New regime"}</td>
      <td class="amount">${formatPaise(s.total)}</td>
      <td class="amount">${formatPaise(s.paid)}</td>
      <td class="amount">
        <strong>${s.balance >= 0
          ? html`${formatPaise(s.balance)} to pay`
          : html`${formatPaise(-s.balance as Paise)} refund`}</strong>
      </td>
    </tr>
  `;
  return html`
    <section class="card" id="paid">
      <h2>Tax already paid</h2>
      <p>
        ${formatPaise(p.paid.tds)} deducted at source,
        ${formatPaise(p.paid.advance)} of advance tax and
        ${formatPaise(p.paid.selfAssessment)} of self-assessment tax, set against each
        regime's figure.
      </p>
      ${p.settlement
        ? html`
            <div class="table-scroll">
              <table>
                <thead><tr><th>Regime</th><th class="amount">Estimate</th><th class="amount">Paid</th><th class="amount">Balance</th></tr></thead>
                <tbody>${line(p.settlement.old)}${line(p.settlement.new)}</tbody>
              </table>
            </div>
          `
        : html``}
      ${p.payments.length > 0
        ? html`
            <div class="table-scroll">
              <table>
                <thead><tr><th>Date</th><th>Kind</th><th class="amount">Amount</th><th>Note</th><th></th></tr></thead>
                <tbody>
                  ${p.payments.map((x) => html`
                    <tr>
                      <td>${formatDate(x.date)}</td>
                      <td>${x.kind === "advance" ? "Advance tax" : "Self-assessment tax"}</td>
                      <td class="amount">${formatPaise(x.amount)}</td>
                      <td class="faint">${x.note ?? ""}</td>
                      <td>
                        <form method="post" action="/tax/payments/${x.id}/delete">
                          <button class="button-small" type="submit">Remove</button>
                        </form>
                      </td>
                    </tr>
                  `)}
                </tbody>
              </table>
            </div>
          `
        : html``}
      <form method="post" action="/tax/payments" style="margin-top:.75rem">
        <input type="hidden" name="fy" value="${p.fy}">
        <div class="row" style="gap:1rem;flex-wrap:wrap;align-items:flex-end">
          <div class="field">
            <label for="tp-kind">Kind</label>
            <select id="tp-kind" name="kind">
              <option value="advance">Advance tax</option>
              <option value="self-assessment">Self-assessment tax</option>
            </select>
          </div>
          <div class="field">
            <label for="tp-date">Date on the challan</label>
            <input id="tp-date" name="date" placeholder="Today">
          </div>
          <div class="field">
            <label for="tp-amount">Amount</label>
            <input id="tp-amount" name="amount" inputmode="decimal" required placeholder="0.00">
          </div>
          <div class="field">
            <label for="tp-note">Note</label>
            <input id="tp-note" name="note" placeholder="Challan 280, BSR code">
          </div>
        </div>
        <button type="submit">Record a payment</button>
      </form>
    </section>
  `;
}
