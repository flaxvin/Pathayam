/**
 * `10` §3.5 · F2.10 · Private lending within the family.
 *
 * B54 · There is no lent/borrowed setting. An arrangement is one running ledger
 * with a person; money moves both ways and the *balance* says who owes whom.
 * When it reaches zero it is settled; while it is non-zero it can be written
 * off (a debt to you) or recorded as forgiven (a debt of yours).
 *
 * FL6/FL9 still shape it: show what is outstanding, since when, and what last
 * moved — without being asked, and with no ageing badge, reminder, or red at
 * ninety days. N18 forbids the app being used to apply pressure; the person on
 * the other side of a family loan is not a debtor to be managed.
 */

import { html, when, type SafeHtml } from "../../http/html.ts";
import { formatPaise, type Paise } from "../../core/money.ts";
import { formatDate } from "../../core/dates.ts";
import type { FamilyLoanView } from "../../domain/family-loans.ts";
import { renderHolderFields } from "./portfolio.ts";

/** How the balance reads, in words, for a view. */
function standing(view: FamilyLoanView): string {
  if (view.writtenOff) return "Written off";
  if (view.settled) return "Settled";
  if (view.owedToYou) return `${view.loan.counterparty} owes you`;
  if (view.owedByYou) return `You owe ${view.loan.counterparty}`;
  return "Nothing moved yet";
}

export function renderFamilyLoans(opts: {
  loans: FamilyLoanView[];
  accounts: { id: string; name: string }[];
  /**
   * H2 / H2.2 · Whose arrangement it is, and whether the household sees it.
   *
   * `14` §6.2 put private assets and loans in the cheap 80%, and the domain has
   * carried holderMemberId and visibility since — but this form never asked, so
   * money lent to *your* cousin was always the household's, visible to everyone.
   * Assets and loans both offer it; this was the one that did not.
   */
  members?: { id: string; name: string }[];
}): SafeHtml {
  /*
   * H2 · Whose arrangement it is, shown when the household has more than one
   * person — the ask was "if shared, the owner should be visible as a tag", and a
   * list of names owed money says nothing about which of you is owed.
   */
  const holderName = (id: string | null | undefined): string | null =>
    (opts.members ?? []).length > 1 && id
      ? (opts.members ?? []).find((m) => m.id === id)?.name ?? null
      : null;

  const active = opts.loans.filter((v) => !v.settled && !v.writtenOff && !v.loan.closed_at);
  const done = opts.loans.filter((v) => v.settled || v.writtenOff || v.loan.closed_at);

  const card = (view: FamilyLoanView) => html`
    <div style="padding:.7rem 0;border-top:1px solid var(--border)">
      <div class="row-between">
        <div>
          <strong>${view.loan.counterparty}</strong>
          ${when(holderName(view.holderMemberId), () => html`
            <span class="chip">${holderName(view.holderMemberId)}</span>
          `)}
          ${when(view.isPrivate, () => html`<span class="chip">private</span>`)}
          ${when(view.settled, () => html`<span class="chip chip-positive">Settled</span>`)}
          ${when(view.writtenOff, () => html`<span class="chip">Written off</span>`)}
          <div class="faint">
            ${standing(view)}
            ${when(view.firstMovement, () => html` · since ${formatDate(view.firstMovement!)}`)}
            ${when(view.daysOutstanding !== null, () => html` · ${view.daysOutstanding} days`)}
          </div>
          <div class="faint">
            ${formatPaise(view.paidOut)} out, ${formatPaise(view.paidIn)} in
            ${when(view.agreedOutstanding !== null && view.owedToYou, () => html`
              · agreed total leaves ${formatPaise(view.agreedOutstanding!)} to come
            `)}
          </div>
          ${when(view.loan.note, () => html`<div class="faint">${view.loan.note}</div>`)}
        </div>
        <div style="text-align:right">
          <div class="figure ${view.owedByYou ? "amount-negative" : ""}">${formatPaise(view.outstanding)}</div>
          <a class="button button-small" href="/family/${view.loan.id}">Open</a>
        </div>
      </div>
    </div>
  `;

  return html`
    <h1>Lending in the family</h1>
    <p class="muted">
      Money moving between you and people rather than institutions. The balance
      comes from what actually moved, so it is never a number anyone has to
      remember — and which way it points tells you who owes whom.
    </p>

    ${opts.loans.length === 0
      ? html`<div class="card empty-state"><p>Nothing recorded yet.</p></div>`
      : html`
          ${when(active.length > 0, () => html`
            <section class="card">
              <h2>Open</h2>
              ${active.map(card)}
            </section>
          `)}
          ${when(done.length > 0, () => html`
            <section class="card">
              <h2>Settled &amp; closed</h2>
              ${done.map(card)}
            </section>
          `)}
        `}

    <section class="card">
      <h2>Record an arrangement</h2>
      <form method="post" action="/family/new">
        ${renderHolderFields(opts.members ?? [])}
        <div class="field">
          <label for="fl-name">Who?</label>
          <input id="fl-name" name="counterparty" required placeholder="Ammu">
          <p class="field-hint">
            One record per person. You will record money moving each way; whether
            it ends up a loan or a debt is just which way the balance points.
          </p>
        </div>
        <div class="field">
          <label for="fl-agreed">Agreed total, if any</label>
          <input id="fl-agreed" name="agreed_total" inputmode="decimal" placeholder="Optional">
          <p class="field-hint">
            If you agreed a figure to come back, put the whole amount here —
            ₹55,000, not "10%". There is no interest calculation.
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

  return html`
    <h1>${view.loan.counterparty}</h1>

    <section class="card">
      <div class="row-between">
        <div>
          <div class="faint">${standing(view)}</div>
          <div class="figure ${view.owedByYou ? "amount-negative" : ""}">${formatPaise(view.outstanding)}</div>
        </div>
        <div style="text-align:right" class="faint">
          ${when(view.firstMovement, () => html`Since ${formatDate(view.firstMovement!)}<br>`)}
          ${formatPaise(view.paidOut)} out · ${formatPaise(view.paidIn)} in
        </div>
      </div>
      ${when(view.writtenOff, () => html`
        <p class="notice notice-info">
          This was settled by writing off the balance. Every line below stays —
          writing off closes the balance, it does not erase what happened.
        </p>
      `)}
    </section>

    ${when(!view.writtenOff, () => html`
      <div class="grid-2">
        <section class="card">
          <h2>You paid them</h2>
          <p class="faint" style="margin-top:-.25rem">Money out to ${view.loan.counterparty}.</p>
          <form method="post" action="/family/${view.loan.id}/advance">
            <div class="field">
              <label for="adv-amount">Amount</label>
              <input id="adv-amount" name="amount" inputmode="decimal" required>
            </div>
            <div class="field">
              <label for="adv-account">From</label>
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
          <h2>They paid you</h2>
          <p class="faint" style="margin-top:-.25rem">Money in from ${view.loan.counterparty}.</p>
          <form method="post" action="/family/${view.loan.id}/repayment">
            <div class="field">
              <label for="rep-amount">Amount</label>
              <input id="rep-amount" name="amount" inputmode="decimal" required>
            </div>
            <div class="field">
              <label for="rep-account">Into</label>
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
        Paying someone is not an expense, and being paid back is not a windfall.
      </p>
    </section>

    ${when(!view.writtenOff && view.outstanding > 0, () => {
      const owedToYou = view.owedToYou;
      return html`
        <section class="card">
          <h2>${owedToYou ? "Write it off" : "They forgave it"}</h2>
          ${opts.confirmingWriteOff
            ? html`
                <p class="notice notice-warning">
                  ${owedToYou
                    ? html`This records ${formatPaise(view.outstanding)} as an expense and closes the balance.`
                    : html`This records ${formatPaise(view.outstanding)} as income and closes the balance.`}
                  Every line above stays. It undoes in one action.
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
                    ${owedToYou ? "Write off" : "Record forgiven"} ${formatPaise(view.outstanding)}
                  </button>
                  <a class="button button-quiet" href="/family/${view.loan.id}">Cancel</a>
                </form>
              `
            : html`
                <p class="faint" style="margin-top:-.25rem">
                  ${owedToYou
                    ? html`For money that is not coming back. It becomes an expense in a category you choose, and the history stays.`
                    : html`If ${view.loan.counterparty} told you to keep it. It becomes income in a category you choose, and the history stays.`}
                </p>
                <form method="post" action="/family/${view.loan.id}/write-off">
                  <button class="button-small" type="submit">
                    ${owedToYou ? "Write it off…" : "Record it as forgiven…"}
                  </button>
                </form>
              `}
        </section>
      `;
    })}

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
