/**
 * P3 · The household screen.
 *
 * One question, answered plainly: what has each of us put toward the shared
 * money this month, and how much of it is still there. `15` §3.3 bounds what it
 * may say — an amount committed and an amount spent, never the balance behind
 * either.
 */

import { html, when, type SafeHtml } from "../../http/html.ts";
import { formatPaise, speakPaise } from "../../core/money.ts";
import { formatMonth } from "../../core/dates.ts";
import type { HouseholdView } from "../../domain/household-view.ts";
import {
  PUT_IT_DOWN_TO_ME, PUT_IT_DOWN_TO_ME_HINT, PICK_IT_UP, PICK_IT_UP_HINT,
  CALL_IT_EVEN, CALL_IT_EVEN_HINT, standingLabel,
} from "../../domain/standing.ts";

export function renderHousehold(
  view: HouseholdView,
  canOpenOwn: boolean,
  /** The viewer's own commitment envelope, when they keep a separate budget. */
  mine?: { categoryId: string; target: number | null; available: number },
): SafeHtml {
  if (!view.separateBudgets) {
    return html`
      <h1>The household's money</h1>
      <p class="muted">
        Everything is in the one shared budget, so there is nothing to split out:
        the budget screen already shows all of it.
      </p>
      <section class="card">
        <h2>Keeping some of it separate</h2>
        <p>
          If you would rather each keep your own accounts and put an agreed
          amount toward the shared bills, open your own budget. Your accounts
          move into it, the household sees what you commit, and it sees nothing
          else.
        </p>
        ${when(canOpenOwn, () => html`
          <form method="post" action="/budgets/personal">
            <button class="button-primary" type="submit">Open my own budget</button>
          </form>
        `)}
      </section>
    `;
  }

  return html`
    <h1>The household's money</h1>
    <p class="muted">
      ${formatMonth(view.month)} · what each of you has put toward the shared
      budget. No money moves to commit it — it stays in the account it is in
      until something shared is actually paid for.
    </p>

    <section class="card">
      <div class="row-between">
        <div>
          <!--
            15 §4A.1 · The sign changes what the figure *is*, so it changes what
            it is called. A negative "still available" is not a small infelicity;
            it is the wrong noun for a household that owes somebody money.
          -->
          <div class="rta-label">
            ${view.due < 0 ? "Underfunded by members" : "Committed and still available"}
          </div>
          <div class="rta-figure">
            <span aria-hidden="true">${formatPaise(Math.abs(view.due) as never)}</span>
            <span class="sr-only">${speakPaise(Math.abs(view.due) as never)}</span>
          </div>
          <p class="muted" style="margin:.25rem 0 0">
            ${view.due < 0
              ? html`
                  More of the household's spending has been paid out of members'
                  own money than they put aside for it, so this much comes off the
                  household's Ready to Assign until it is settled.
                `
              : html`
                  This is part of the household's Ready to Assign, alongside what
                  is in its own accounts.
                `}
          </p>
        </div>
        <div style="text-align:right">
          <div class="chip">Put in this month ${formatPaise(view.committedThisMonth)}</div>
          <div class="chip" style="margin-top:.35rem">
            Paid for the household ${formatPaise(view.spentThisMonth)}
          </div>
        </div>
      </div>
    </section>

    <section class="card">
      <h2>Who has put in what</h2>
      <table class="table">
        <thead>
          <tr>
            <th scope="col">Whose</th>
            <!-- The row has to add up on its face, or it reads as a bug. -->
            <th scope="col" class="numeric">Brought forward</th>
            <th scope="col" class="numeric">Put in this month</th>
            <th scope="col" class="numeric">Paid for the household</th>
            <th scope="col" class="numeric">Where it stands</th>
            <th scope="col">Monthly plan</th>
          </tr>
        </thead>
        <tbody>
          ${view.members.map(
            (m) => html`
              <tr>
                <th scope="row">${m.name}</th>
                <td class="numeric ${m.broughtForward < 0 ? "negative" : ""}">
                  ${m.broughtForward === 0
                    ? html`<span class="faint">—</span>`
                    : m.broughtForward < 0
                      ? html`${formatPaise(Math.abs(m.broughtForward) as never)}
                             <span class="faint">underfunded</span>`
                      : formatPaise(m.broughtForward)}
                </td>
                <td class="numeric">${formatPaise(m.assignedThisMonth)}</td>
                <td class="numeric">${formatPaise(m.spentThisMonth)}</td>
                <td class="numeric ${m.standing === "underfunded" ? "negative" : ""}">
                  ${m.standing === "even"
                    ? html`<span class="faint">square</span>`
                    : html`
                        ${formatPaise(m.outstanding)}
                        <span class="chip ${m.standing === "underfunded" ? "chip-warning" : ""}">
                          ${standingLabel(m.available)}
                        </span>
                      `}
                </td>
                <td>
                  ${m.target === null
                    ? html`<span class="faint">none set</span>`
                    : m.shortOfTarget > 0
                      ? html`
                          ${formatPaise(m.target)} —
                          <span class="negative">${formatPaise(m.shortOfTarget)} short</span>
                        `
                      : html`${formatPaise(m.target)} <span class="chip chip-good">met</span>`}
                </td>
              </tr>
            `,
          )}
        </tbody>
      </table>
      <p class="faint">
        Brought forward, plus what went in, less what they paid for, is where it
        stands. <strong>Underfunded</strong> means more of the household's spending
        was paid out of their money than they had put aside for it. Nothing expires at month end — it carries forward
        until one of you settles it, which is what the options below are for.
      </p>
    </section>

    ${when(Boolean(mine), () => html`
      <section class="card">
        <h2>What I put in each month</h2>
        <p class="muted">
          A standing figure, so agreeing <em>₹40,000 a month</em> is settled once
          rather than remembered every month. It does not move money on its own —
          it is what the budget screen measures you against, and what auto-assign
          fills.
        </p>
        <form method="post" action="/categories/${mine!.categoryId}/target"
              class="row" style="gap:.5rem;align-items:flex-end">
          <div class="field" style="margin:0">
            <label for="commit-target">Each month</label>
            <input id="commit-target" name="amount" class="amount-input" type="text"
                   inputmode="decimal" placeholder="none"
                   value="${mine!.target === null ? "" : (mine!.target / 100).toFixed(2)}">
          </div>
          <button type="submit">Save</button>
        </form>
        <p class="faint">
          Leave it empty to have no standing figure. Clearing it changes nothing
          about where you stand —
          ${mine!.available < 0
            ? html`your commitment is still
                   ${formatPaise(Math.abs(mine!.available) as never)} underfunded`
            : mine!.available > 0
              ? html`${formatPaise(mine!.available as never)} is still committed`
              : html`you are square with the household`}.
        </p>
      </section>
    `)}

    ${when(view.underfunded.length > 0, () => html`
      <section class="card">
        <h2>Squaring up</h2>
        <p class="muted">
          ${view.underfunded.map((m) => m.name).join(" and ")}
          ${view.underfunded.length === 1 ? "has" : "have"} a commitment that is
          short. There are three ways that can be settled, and they are not the
          same thing.
        </p>
        ${view.underfunded.map(
          (m) => {
            /*
             * Only the option that is yours to take. Offering both and greying
             * one out asked the reader to work out which applied to them —
             * funding your own commitment and picking up somebody else's are the
             * same amount of money and opposite acts.
             */
            const isMine = Boolean(mine) && mine!.categoryId === m.categoryId;
            return html`
            <div style="padding:.7rem 0;border-top:1px solid var(--border)">
              <p><strong>${m.sentence}</strong></p>
              <ul class="plain">
                <!--
                  All three take an amount, because all three can be partial — a
                  month is often settled in pieces. Two of them used to carry the
                  whole figure baked into the label while the third had a box,
                  which made them look like different kinds of thing.
                -->
                ${isMine
                  ? html`
                      <li>
                        <strong>${PUT_IT_DOWN_TO_ME}</strong> — ${PUT_IT_DOWN_TO_ME_HINT}
                        <form method="get" action="/move"
                              class="row" style="gap:.4rem;align-items:flex-end;margin-top:.3rem">
                          <input type="hidden" name="to" value="${m.categoryId}">
                          <input type="hidden" name="month" value="${view.month}">
                          <div class="field" style="margin:0">
                            <label style="font-size:.75rem" for="down-${m.categoryId}">How much</label>
                            <input id="down-${m.categoryId}" name="amount" class="amount-input"
                                   style="max-width:8rem" type="text" inputmode="decimal"
                                   value="${(m.outstanding / 100).toFixed(2)}">
                          </div>
                          <button class="button-small" type="submit">${PUT_IT_DOWN_TO_ME}</button>
                        </form>
                      </li>
                    `
                  : html`
                      <li>
                        <strong>${PICK_IT_UP}</strong> — ${PICK_IT_UP_HINT}
                        ${when(Boolean(mine), () => html`
                          <form method="post" action="/household/pick-up"
                                class="row" style="gap:.4rem;align-items:flex-end;margin-top:.3rem">
                            <input type="hidden" name="envelope_id" value="${mine!.categoryId}">
                            <input type="hidden" name="month" value="${view.month}">
                            <div class="field" style="margin:0">
                              <label style="font-size:.75rem" for="pick-${m.categoryId}">How much</label>
                              <input id="pick-${m.categoryId}" name="amount" class="amount-input"
                                     style="max-width:8rem" type="text" inputmode="decimal"
                                     value="${(m.outstanding / 100).toFixed(2)}">
                            </div>
                            <button class="button-small" type="submit">${PICK_IT_UP}</button>
                          </form>
                        `)}
                        ${when(!mine, () => html`
                          <span class="faint">
                            — you would need a budget of your own to commit from.
                          </span>
                        `)}
                      </li>
                      <li class="faint">
                        ${m.name} can instead put it down to themselves, from their
                        own Ready to Assign.
                      </li>
                    `}
                <li>
                  <strong>${CALL_IT_EVEN}</strong> — ${CALL_IT_EVEN_HINT}
                  ${when(Boolean(m.givingUp), () => html`
                    <!--
                      15 §4A.5 · Both halves. An expense for the one giving it up
                      and income for the one released from it — saying only the
                      first makes it look like money disappearing.
                    -->
                    <p class="field-hint" style="margin:.35rem 0 0">
                      <strong>On the giving side</strong>, it becomes spending in
                      ${m.givingUp!.budgetName} — from
                      <strong>${m.givingUp!.categoryName}</strong> unless you pick
                      another below. That envelope sits in the red until it is
                      funded, and that is where the money actually comes from.
                    </p>
                    <p class="field-hint" style="margin:.2rem 0 0">
                      <strong>On the other side</strong>, ${m.givingUp!.receiverName}
                      is better off by the same amount: it arrives as income, so Ready
                      to Assign rises by it. Nothing is owed any more.
                    </p>
                  `)}
                  <form method="post" action="/household/call-it-even"
                        class="row" style="gap:.4rem;align-items:flex-end;margin-top:.3rem;flex-wrap:wrap">
                    <input type="hidden" name="envelope_id" value="${m.categoryId}">
                    <input type="hidden" name="month" value="${view.month}">
                    <div class="field" style="margin:0">
                      <label style="font-size:.75rem" for="even-${m.categoryId}">How much</label>
                      <input id="even-${m.categoryId}" name="amount" class="amount-input"
                             style="max-width:8rem" type="text" inputmode="decimal"
                             value="${(m.outstanding / 100).toFixed(2)}">
                    </div>
                    ${when((m.givingUp?.choices.length ?? 0) > 0, () => html`
                      <div class="field" style="margin:0">
                        <label style="font-size:.75rem" for="even-cat-${m.categoryId}">
                          Spent from
                        </label>
                        <select id="even-cat-${m.categoryId}" name="giving_category_id"
                                style="max-width:14rem">
                          <option value="">${m.givingUp!.categoryName}${m.givingUp!.exists ? "" : " (new)"}</option>
                          ${m.givingUp!.choices
                            .filter((c) => c.name !== m.givingUp!.categoryName)
                            .map((c) => html`<option value="${c.id}">${c.name}</option>`)}
                        </select>
                      </div>
                    `)}
                    <button class="button-small" type="submit">${CALL_IT_EVEN}</button>
                  </form>
                </li>
              </ul>
            </div>
          `;
          },
        )}
      </section>
    `)}


    ${when(view.settled.length > 0, () => html`
      <!--
        15 §4A.3 · Calling it even is the only one of the three endings that
        actually lets something go, and it was recorded in full and shown
        nowhere. An agreement between two people about money is precisely the
        thing they will want to be able to point at in six months.
      -->
      <section class="card">
        <h2>What we have called even</h2>
        <p class="muted">
          ${formatPaise(view.settledTotal)} settled by agreement, up to
          ${formatMonth(view.month)}. Nobody owes any of it.
        </p>
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Month</th>
                <th scope="col">Whose</th>
                <th scope="col" class="num">Amount</th>
                <th scope="col">Given up by</th>
              </tr>
            </thead>
            <tbody>
              ${view.settled.map((s) => html`
                <tr>
                  <td>${formatMonth(s.month)}</td>
                  <td>${s.name}</td>
                  <td class="num amount">${formatPaise(s.amount)}</td>
                  <td>
                    ${s.givingBudgetName}, from ${s.givingCategoryName}
                    ${when(s.note, () => html`<span class="faint"> — ${s.note}</span>`)}
                  </td>
                </tr>
              `)}
            </tbody>
          </table>
        </div>
      </section>
    `)}

    <section class="card">
      <h2>How this works</h2>
      <p>
        Committing is assigning, not transferring. Money you commit stays in your
        own account and appears here for the household to assign — to the rent,
        the groceries, whatever you have agreed. When a shared bill is paid from
        your account, your commitment falls by what was spent.
      </p>
      <p class="muted">
        Nobody sees anybody else's accounts, balances or other envelopes. What is
        on this page is all that is shared.
      </p>
    </section>
  `;
}
