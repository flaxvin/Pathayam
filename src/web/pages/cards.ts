/**
 * F2.3 / R6 · The cards, in the order they fall due.
 *
 * This household carries seven credit cards, each on its own billing cycle, and
 * the question they ask most often has no screen: *which card do I pay next, how
 * much, and is the money already set aside?* Accounts groups by kind and sorts
 * by name, which answers none of that; the loan pages answer it for loans and
 * nothing answered it for cards.
 *
 * Everything here is already in the app — the statement, the envelope, the
 * funding shortfall. It had never been put on one page in due-date order.
 */

import { html, raw, when, type SafeHtml } from "../../http/html.ts";
import { formatPaise, type Paise } from "../../core/money.ts";
import { formatDate, type IsoDate } from "../../core/dates.ts";

export interface CardDue {
  accountId: string;
  name: string;
  last4: string | null;
  /** What the card owes right now, positive when money is owed. */
  owed: Paise;
  /** What its payment envelope holds. */
  funded: Paise;
  /** R6 · Of what it owes, how much has nothing behind it. */
  unfunded: Paise;
  /** The most recent statement, when one has been recorded. */
  statement: { amount: Paise; date: IsoDate; due: IsoDate; minimum: Paise | null } | null;
  /** Days until the statement's due date; negative once it has passed. */
  daysToDue: number | null;
  /** B127 · What has come off the card since the statement was issued. */
  paidSinceStatement: Paise;
  paymentCategoryId: string | null;
}

function urgency(card: CardDue): { label: string; chip: string } | null {
  if (card.daysToDue === null) return null;
  /*
   * B127 · Settled first, before anything about dates. A statement that has been
   * paid is not late however long ago it was due, and saying otherwise on the
   * screen whose whole job is "which card is due next" trains people to ignore
   * the one that matters.
   */
  if (card.statement && card.paidSinceStatement >= card.statement.amount) {
    return { label: "Paid", chip: "chip-positive" };
  }
  if (card.daysToDue < 0) {
    return { label: `${Math.abs(card.daysToDue)} days overdue`, chip: "chip-danger" };
  }
  if (card.daysToDue === 0) return { label: "Due today", chip: "chip-danger" };
  if (card.daysToDue <= 3) return { label: `Due in ${card.daysToDue} days`, chip: "chip-warning" };
  return { label: `Due in ${card.daysToDue} days`, chip: "" };
}

export function renderCards(opts: { cards: CardDue[]; month: string }): SafeHtml {
  const { cards } = opts;

  if (cards.length === 0) {
    return html`
      <h1>Cards</h1>
      <div class="card empty-state">
        <div class="empty-icon" aria-hidden="true">▤</div>
        <h2>No credit cards yet</h2>
        <p>Add one and its spending will reserve the cash to clear it (R6).</p>
        <p><a class="button button-primary" href="/accounts/new">Add an account</a></p>
      </div>
    `;
  }

  const owed = cards.reduce((sum, c) => sum + c.owed, 0) as Paise;
  const unfunded = cards.reduce((sum, c) => sum + c.unfunded, 0) as Paise;
  const dueSoon = cards.filter((c) => c.daysToDue !== null && c.daysToDue <= 7);

  return html`
    <h1>Cards</h1>
    <p class="muted">
      In the order they fall due. Spending on a card reserves the cash to clear
      it, so a card is only a surprise if something was spent without an
      envelope behind it.
    </p>

    <section class="card">
      <div class="row" style="gap:2rem;flex-wrap:wrap">
        <div>
          <div class="faint">Owed across ${cards.length} cards</div>
          <strong class="amount amount-negative" style="font-size:1.25rem">${formatPaise(owed)}</strong>
        </div>
        <div>
          <div class="faint">Not funded</div>
          <strong class="amount ${unfunded > 0 ? "amount-negative" : ""}" style="font-size:1.25rem">
            ${formatPaise(unfunded)}
          </strong>
        </div>
        <div>
          <div class="faint">Due within a week</div>
          <strong style="font-size:1.25rem">${dueSoon.length}</strong>
        </div>
      </div>
      ${when(unfunded === 0, () => html`
        <p class="faint" style="margin-bottom:0">
          Every rupee on these cards has an envelope behind it. Paying them all
          today would take nothing you had not already set aside.
        </p>
      `)}
    </section>

    ${cards.map((card) => renderCard(card, opts.month))}
  `;
}

function renderCard(card: CardDue, month: string): SafeHtml {
  const state = urgency(card);
  return html`
    <section class="card">
      <div class="row-between" style="gap:1rem;align-items:flex-start">
        <div style="min-width:0">
          <h2 style="margin-bottom:.15rem">
            <a href="/accounts/${card.accountId}">${card.name}</a>
            ${when(card.last4, () => html`<span class="faint">····${card.last4}</span>`)}
          </h2>
          <div class="faint">
            ${card.statement
              ? html`
                  Statement ${formatPaise(card.statement.amount)} on
                  ${formatDate(card.statement.date)}, due ${formatDate(card.statement.due)}${
                    card.statement.minimum !== null
                      ? html` · minimum ${formatPaise(card.statement.minimum)}`
                      : raw("")
                  }
                `
              : html`
                  No statement recorded yet — the due date is whatever the bank
                  says until you enter one.
                `}
          </div>
        </div>
        <div style="text-align:right">
          <div class="amount amount-negative" style="font-size:1.15rem">${formatPaise(card.owed)}</div>
          ${when(state, () => html`<span class="chip ${state!.chip}">${state!.label}</span>`)}
        </div>
      </div>

      <div class="row" style="gap:2rem;flex-wrap:wrap;margin-top:.75rem">
        <div>
          <div class="faint">Set aside</div>
          <span class="amount">${formatPaise(card.funded)}</span>
        </div>
        ${when(card.unfunded > 0, () => html`
          <div>
            <div class="faint">Not funded</div>
            <span class="amount amount-negative">${formatPaise(card.unfunded)}</span>
          </div>
        `)}
      </div>

      ${when(card.unfunded > 0, () => html`
        <p class="notice notice-warning" style="margin-top:.75rem">
          ${formatPaise(card.unfunded)} of this balance has nothing behind it.
          ${when(card.paymentCategoryId, () => html`
            <a href="/move?to=${card.paymentCategoryId}&amount=${(card.unfunded / 100).toFixed(2)}&month=${month}">Fund it</a>
          `)}
        </p>
      `)}

      <div class="row" style="gap:.5rem;margin-top:.75rem;flex-wrap:wrap">
        ${when(card.owed > 0, () => html`
          <a class="button button-small button-primary"
             href="/transfer?to=${card.accountId}&amount=${card.owed}">Pay it off</a>
        `)}
        <a class="button button-small" href="/accounts/${card.accountId}/statement">Record a statement</a>
        <a class="button button-small button-quiet" href="/accounts/${card.accountId}">Register</a>
      </div>
    </section>
  `;
}
