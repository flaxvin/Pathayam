/**
 * S · Financial independence.
 *
 * The screen's job is not to show a number — that part is one division — but to
 * keep the number's meaning attached to it. A FIRE target is annual spending
 * multiplied by roughly thirty, so every assumption behind it arrives magnified
 * thirty times, and a page that prints the total without its inputs is inviting
 * somebody to plan a life around arithmetic they cannot inspect.
 *
 * So the corpus is itemised, what was left out is itemised *too* and says why,
 * the withdrawal rate is a control rather than a constant, and the familiar 4%
 * answer sits next to the cautious one instead of being suppressed. Where the
 * projection cannot honestly answer — no income recorded, less than a year of
 * history, no age given for the provident-fund bridge — it says so rather than
 * printing a confident zero.
 */

import { html, when, type SafeHtml } from "../../http/html.ts";
import { formatPaise, type Paise } from "../../core/money.ts";
import { formatMonth } from "../../core/dates.ts";
import { progressRing } from "../charts.ts";
import type { FireProjection, CorpusLine } from "../../domain/fire.ts";

const EXCLUDED_REASON: Record<string, string> = {
  physical: "a home or vehicle — you cannot sell a tenth of it each year",
  receivable: "money owed to you, not money you hold",
  asset: "untyped, so it could be either — give it a kind to have it counted",
};

function years(value: number): string {
  if (value < 1 / 12) return "now";
  if (value < 1) return `${Math.round(value * 12)} months`;
  const whole = Math.floor(value);
  const months = Math.round((value - whole) * 12);
  if (months === 0) return `${whole} ${whole === 1 ? "year" : "years"}`;
  if (months === 12) return `${whole + 1} years`;
  return `${whole}y ${months}m`;
}

function lineTable(lines: CorpusLine[], withReason = false): SafeHtml {
  return html`
    <div class="table-scroll">
      <table>
        <tbody>
          ${lines.map((l) => html`
            <tr>
              <td><a href="/accounts/${l.accountId}">${l.label}</a></td>
              ${when(withReason, () => html`
                <td class="faint">${EXCLUDED_REASON[l.subtype] ?? l.subtype}</td>
              `)}
              <td class="amount">${formatPaise(l.value)}</td>
            </tr>
          `)}
        </tbody>
      </table>
    </div>
  `;
}

export function renderFire(opts: { projection: FireProjection }): SafeHtml {
  const p = opts.projection;
  const rate = (p.assumptions.withdrawalRateBp / 100).toFixed(2).replace(/\.?0+$/, "");
  const realReturn = (p.assumptions.realReturnBp / 100).toFixed(2).replace(/\.?0+$/, "");

  return html`
    <div class="row-between" style="margin-bottom:1rem">
      <h1>Financial independence</h1>
    </div>

    ${when(p.annualExpenses === 0, () => html`
      <div class="card empty-state">
        <div class="empty-icon" aria-hidden="true">△</div>
        <h2>Nothing spent yet</h2>
        <p>
          This projection is built from what the household actually spent, so it
          needs some spending to read. Categorise a few months of transactions
          and it will fill in.
        </p>
      </div>
    `)}

    ${when(p.annualExpenses > 0, () => html`
      <section class="card">
        <div class="row-between" style="align-items:center;gap:1.5rem;flex-wrap:wrap">
          <div>
            <p class="faint" style="margin:0">You would need</p>
            <p style="font-size:2rem;margin:.2rem 0">${formatPaise(p.fireNumber)}</p>
            <p class="faint" style="margin:0">
              to draw ${formatPaise(p.annualExpenses)} a year at ${rate}%, indefinitely.
            </p>
          </div>
          ${progressRing({
            percent: p.progressPct,
            title: `${Math.round(p.progressPct)}% of the way there`,
            center: `${Math.round(p.progressPct)}%`,
          })}
        </div>

        <div class="grid-2" style="margin-top:1rem">
          <div>
            <p class="faint" style="margin:0">You hold</p>
            <p style="margin:.2rem 0">${formatPaise(p.corpus)}</p>
          </div>
          <div>
            <p class="faint" style="margin:0">Still to find</p>
            <p style="margin:.2rem 0">${formatPaise(p.shortfall)}</p>
          </div>
        </div>

        <p style="margin-top:1rem">
          ${p.yearsToFire === null
            ? html`
                <strong>Not on the current pattern.</strong> The household is
                spending what it earns, or close enough that the corpus does not
                climb towards the target. The lever is the gap between income and
                spending, not the return.
              `
            : html`
                About <strong>${years(p.yearsToFire)}</strong> away
                ${p.fireMonth ? html`— around ${formatMonth(p.fireMonth)}` : html``},
                saving ${formatPaise(p.annualSavings)} a year at ${realReturn}%
                after inflation.
              `}
        </p>
      </section>

      <section class="card">
        <h2>Where the number comes from</h2>
        <div class="table-scroll">
          <table>
            <tbody>
              <tr>
                <td>Spending, last ${Math.round(p.windowDays / 30)} months, annualised</td>
                <td class="amount">${formatPaise(p.annualExpenses)}</td>
              </tr>
              <tr>
                <td>Income, same window</td>
                <td class="amount">${formatPaise(p.annualIncome)}</td>
              </tr>
              <tr>
                <td>Saved</td>
                <td class="amount">
                  ${formatPaise(p.annualSavings)}
                  ${p.savingsRatePct === null
                    ? html`<span class="faint"> · no income recorded</span>`
                    : html`<span class="faint"> · ${Math.round(p.savingsRatePct)}% of income</span>`}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="faint">
          Spending is money leaving your envelopes, so a card swipe counts on the
          day you make it and paying the card off afterwards does not count again.
          Transfers and income never touch an envelope.
        </p>
        ${when(p.windowIsShort, () => html`
          <p class="warn">
            There is less than a full year of history here, so this is a short
            window scaled up to a year. A single unusual month moves it a long way.
          </p>
        `)}
      </section>

      <section class="card">
        <h2>What is counted</h2>
        ${p.drawableLines.length > 0
          ? lineTable(p.drawableLines)
          : html`<p class="faint">Nothing drawable is tracked yet.</p>`}
        <p class="row-between"><strong>Available now</strong>
          <strong>${formatPaise(p.drawableNow)}</strong></p>

        ${when(p.lockedLines.length > 0, () => html`
          <h3>Locked until ${p.assumptions.unlockAge}</h3>
          ${lineTable(p.lockedLines)}
          <p class="faint">
            A provident fund is real money and part of the plan, but it cannot be
            drawn before ${p.assumptions.unlockAge}. It is
            ${p.assumptions.includeLocked
              ? html`counted towards the target`
              : html`left out of the target`}.
          </p>
        `)}

        ${when(p.excludedLines.length > 0, () => html`
          <h3>Not counted</h3>
          ${lineTable(p.excludedLines, true)}
          <p class="faint">
            ${formatPaise(p.excluded)} appears on your net worth and not here.
            Net worth asks what you are worth; this page asks what could pay for
            groceries in a year you do not work.
          </p>
        `)}
      </section>

      ${when(p.bridgeYears !== null && p.bridgeYears > 0, () => html`
        <section class="card">
          <h2>The bridge</h2>
          <p>
            Stopping then would leave about <strong>${years(p.bridgeYears!)}</strong>
            before the provident fund unlocks at ${p.assumptions.unlockAge}. That
            stretch has to come from what is available now — roughly
            ${formatPaise(Math.round(p.annualExpenses * p.bridgeYears!) as Paise)}
            at today's spending.
          </p>
          <p class="${p.bridgeCovered ? "faint" : "warn"}">
            ${p.bridgeCovered
              ? html`Your available corpus covers it.`
              : html`
                  Your available corpus does not cover it yet. A plan that counts
                  the locked fund towards the target can still fail here: the
                  money is real but arrives too late.
                `}
          </p>
        </section>
      `)}

      <section class="card">
        <h2>Assumptions</h2>
        <form method="get" action="/fire">
          <div class="grid-2">
            <div class="field">
              <label for="swr">Withdrawal rate (%)</label>
              <input id="swr" name="swr" type="text" inputmode="decimal" value="${rate}">
            </div>
            <div class="field">
              <label for="ret">Return after inflation (%)</label>
              <input id="ret" name="ret" type="text" inputmode="decimal" value="${realReturn}">
            </div>
          </div>
          <div class="grid-2">
            <div class="field">
              <label for="age">Your age (optional)</label>
              <input id="age" name="age" type="text" inputmode="numeric"
                     value="${p.assumptions.currentAge ?? ""}">
            </div>
            <div class="field">
              <label for="locked">Count locked retirement balances</label>
              <select id="locked" name="locked">
                <option value="1" ${p.assumptions.includeLocked ? "selected" : ""}>Yes</option>
                <option value="0" ${p.assumptions.includeLocked ? "" : "selected"}>No</option>
              </select>
            </div>
          </div>
          <button class="button button-primary" type="submit">Recalculate</button>
        </form>

        <p class="faint" style="margin-top:1rem">
          The 4% rule comes from US data over a 30-year retirement. Indian
          inflation has run higher, and stopping early asks the money to last
          longer than thirty years — both push the sustainable rate down, which
          is why this starts at 3.5%. At 4% the target would be
          ${formatPaise(p.fireNumberAtFourPercent)} instead.
        </p>
        <p class="faint">
          Every figure here is arithmetic on your own numbers and on the
          assumptions above. It is not financial advice, it assumes your spending
          stays roughly as it is, and it cannot know what markets will do.
        </p>
      </section>
    `)}
  `;
}
