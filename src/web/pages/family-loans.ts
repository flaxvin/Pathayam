/**
 * `10` §3.5 · F2.10 · Private lending within the family.
 *
 * The screen is shaped by FL6 and FL9 together. FL6 says show what is
 * outstanding, since when, and what was last repaid — without being asked.
 * FL9 says do nothing else: no reminder, no ageing badge, no colour that turns
 * red at ninety days. N18 forbids the app being used to apply pressure, and the
 * person on the other side of a family loan is not a debtor to be managed.
 *
 * So the ages here are stated in plain grey text, the same weight as every
 * other fact on the page, and there is no sort-by-oldest.
 */

import { html, when, type SafeHtml } from "../../http/html.ts";
import { formatPaise, type Paise } from "../../core/money.ts";
import { formatDate } from "../../core/dates.ts";
import type { FamilyLoanView } from "../../domain/family-loans.ts";

export function renderFamilyLoans(opts: {
  loans: FamilyLoanView[];
  accounts: { id: string; name: string }[];
}): SafeHtml {
  const lent = opts.loans.filter((v) => v.loan.direction === "lent");
  const borrowed = opts.loans.filter((v) => v.loan.direction === "borrowed");

  const card = (view: FamilyLoanView) => html`
    <div style="padding:.7rem 0;border-top:1px solid var(--border)">
      <div class="row-between">
        <div>
          <strong>${view.loan.counterparty}</strong>
          ${when(view.settled, () => html`<span class="chip chip-positive">Settled</span>`)}
          ${when(view.writtenOff, () => html`<span class="chip">Written off</span>`)}
          <div class="faint">
            ${when(view.firstAdvance, () => html`Since ${formatDate(view.firstAdvance!)}`)}
            ${when(view.daysOutstanding !== null, () => html` · ${view.daysOutstanding} days`)}
            ${when(view.lastRepayment, () => html`
              · last repayment ${formatPaise(view.lastRepayment!.amount)}
              on ${formatDate(view.lastRepayment!.date)}
            `)}
          </div>
          <div class="faint">
            ${formatPaise(view.advanced)} out, ${formatPaise(view.repaid)} back
            ${when(view.agreedOutstanding !== null, () => html`
              · agreed total leaves ${formatPaise(view.agreedOutstanding!)} owing
            `)}
          </div>
          ${when(view.loan.note, () => html`<div class="faint">${view.loan.note}</div>`)}
        </div>
        <div style="text-align:right">
          <div class="figure">${formatPaise(view.outstanding)}</div>
          <a class="button-small" href="/family/${view.loan.id}">Open</a>
        </div>
      </div>
    </div>
  `;

  return html`
    <h1>Lending in the family</h1>
    <p class="muted">
      Money lent to or borrowed from people rather than institutions. The
      balance comes from what actually moved, so it is never a number anyone
      has to remember.
    </p>

    ${opts.loans.length === 0
      ? html`
          <div class="card empty-state">
            <p>Nothing recorded yet.</p>
          </div>
        `
      : html`
          ${when(lent.length > 0, () => html`
            <section class="card">
              <h2>Lent out</h2>
              ${lent.map(card)}
            </section>
          `)}
          ${when(borrowed.length > 0, () => html`
            <section class="card">
              <h2>Borrowed</h2>
              ${borrowed.map(card)}
            </section>
          `)}
        `}

    <section class="card">
      <h2>Record an arrangement</h2>
      <form method="post" action="/family/new">
        <div class="field">
          <label for="fl-name">Who?</label>
          <input id="fl-name" name="counterparty" required placeholder="Ammu">
        </div>
        <div class="field">
          <label for="fl-direction">Which way?</label>
          <select id="fl-direction" name="direction">
            <option value="lent">I lent them money</option>
            <option value="borrowed">I borrowed from them</option>
          </select>
        </div>
        <div class="field">
          <label for="fl-agreed">Agreed total, if any</label>
          <input id="fl-agreed" name="agreed_total" inputmode="decimal" placeholder="Optional">
          <p class="field-hint">
            If you agreed to return more than was lent, put the whole figure
            here — ₹55,000, not "10%". There is no interest calculation.
          </p>
        </div>
        <div class="field">
          <label for="fl-note">Note</label>
          <input id="fl-note" name="note" placeholder="Optional — what it was for">
        </div>
        <button class="button-primary" type="submit">Start tracking it</button>
      </form>
      ${when(opts.accounts.length === 0, () => html`
        <p class="notice notice-warning">
          You will need a bank account before you can record money moving.
        </p>
      `)}
    </section>
  `;
}

export function renderFamilyLoan(opts: {
  view: FamilyLoanView;
  accounts: { id: string; name: string }[];
  categories: { id: string; name: string }[];
  entries: { date: string; amount: Paise; memo: string | null }[];
  confirmingWriteOff?: boolean;
}): SafeHtml {
  const { view } = opts;
  const lent = view.loan.direction === "lent";

  return html`
    <h1>${lent ? "Lent to" : "Borrowed from"} ${view.loan.counterparty}</h1>

    <section class="card">
      <div class="row-between">
        <div>
          <div class="faint">Outstanding</div>
          <div class="figure">${formatPaise(view.outstanding)}</div>
        </div>
        <div style="text-align:right" class="faint">
          ${when(view.firstAdvance, () => html`
            Since ${formatDate(view.firstAdvance!)}<br>
          `)}
          ${formatPaise(view.advanced)} out · ${formatPaise(view.repaid)} back
        </div>
      </div>
      ${when(view.writtenOff, () => html`
        <p class="notice notice-info">
          This was written off. The advances are still here — writing off closes
          the balance, it does not erase what happened.
        </p>
      `)}
    </section>

    ${when(!view.writtenOff, () => html`
      <div class="grid-2">
        <section class="card">
          <h2>${lent ? "Lend more" : "Borrow more"}</h2>
          <form method="post" action="/family/${view.loan.id}/advance">
            <div class="field">
              <label for="adv-amount">Amount</label>
              <input id="adv-amount" name="amount" inputmode="decimal" required>
            </div>
            <div class="field">
              <label for="adv-account">${lent ? "From" : "Into"}</label>
              <select id="adv-account" name="account_id" required>
                ${opts.accounts.map((a) => html`<option value="${a.id}">${a.name}</option>`)}
              </select>
            </div>
            <div class="field">
              <label for="adv-date">When</label>
              <input id="adv-date" name="date" placeholder="Today">
            </div>
            <button type="submit">Record it</button>
          </form>
        </section>

        <section class="card">
          <h2>${lent ? "They repaid" : "I repaid"}</h2>
          <form method="post" action="/family/${view.loan.id}/repayment">
            <div class="field">
              <label for="rep-amount">Amount</label>
              <input id="rep-amount" name="amount" inputmode="decimal" required>
            </div>
            <div class="field">
              <label for="rep-account">${lent ? "Into" : "From"}</label>
              <select id="rep-account" name="account_id" required>
                ${opts.accounts.map((a) => html`<option value="${a.id}">${a.name}</option>`)}
              </select>
            </div>
            <div class="field">
              <label for="rep-date">When</label>
              <input id="rep-date" name="date" placeholder="Today">
            </div>
            <button type="submit">Record it</button>
          </form>
        </section>
      </div>
    `)}

    <section class="card">
      <h2>What has moved</h2>
      ${opts.entries.length === 0
        ? html`<p class="muted">Nothing yet.</p>`
        : html`
            <table>
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">What</th>
                  <th scope="col" class="numeric">Amount</th>
                </tr>
              </thead>
              <tbody>
                ${opts.entries.map(
                  (e) => html`
                    <tr>
                      <td>${formatDate(e.date as never)}</td>
                      <td>${e.memo ?? ""}</td>
                      <td class="numeric">${formatPaise(e.amount)}</td>
                    </tr>
                  `,
                )}
              </tbody>
            </table>
          `}
      <p class="field-hint">
        Every line is a transfer, so none of it counts as spending or income.
        Lending money is not an expense, and being repaid is not a windfall.
      </p>
    </section>

    ${when(lent && !view.writtenOff && view.outstanding > 0, () => html`
      <section class="card">
        <h2>Write it off</h2>
        ${opts.confirmingWriteOff
          ? html`
              <p class="notice notice-warning">
                This records ${formatPaise(view.outstanding)} as an expense and
                closes the balance. Every advance and repayment stays. It undoes
                in one action.
              </p>
              <form method="post" action="/family/${view.loan.id}/write-off">
                <input type="hidden" name="confirm" value="1">
                <div class="field">
                  <label for="wo-category">Which category should carry it?</label>
                  <select id="wo-category" name="category_id" required>
                    ${opts.categories.map((c) => html`<option value="${c.id}">${c.name}</option>`)}
                  </select>
                </div>
                <button class="button-danger" type="submit">
                  Write off ${formatPaise(view.outstanding)}
                </button>
                <a class="button button-quiet" href="/family/${view.loan.id}">Cancel</a>
              </form>
            `
          : html`
              <p class="faint" style="margin-top:-.25rem">
                For money that is not coming back. It becomes an expense in a
                category you choose, and the history stays.
              </p>
              <form method="post" action="/family/${view.loan.id}/write-off">
                <button class="button-small" type="submit">Write it off…</button>
              </form>
            `}
      </section>
    `)}

    ${when(view.settled && !view.loan.closed_at, () => html`
      <section class="card">
        <p>This is settled. You can close it and keep every line above.</p>
        <form method="post" action="/family/${view.loan.id}/close">
          <button type="submit">Close it</button>
        </form>
      </section>
    `)}
  `;
}
