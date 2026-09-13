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
  CALL_IT_EVEN, CALL_IT_EVEN_HINT,
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
          <div class="rta-label">Committed and still available</div>
          <div class="rta-figure">
            <span aria-hidden="true">${formatPaise(view.due)}</span>
            <span class="sr-only">${speakPaise(view.due)}</span>
          </div>
          <p class="muted" style="margin:.25rem 0 0">
            This is part of the household's Ready to Assign, alongside what is in
            its own accounts.
          </p>
        </div>
        <div style="text-align:right">
          <div class="chip">Put in this month ${formatPaise(view.committedThisMonth)}</div>
          <div class="chip" style="margin-top:.35rem">
            Spent this month ${formatPaise(view.spentThisMonth)}
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
            <th scope="col" class="numeric">Put in this month</th>
            <th scope="col" class="numeric">Spent</th>
            <th scope="col" class="numeric">Where it stands</th>
            <th scope="col">Monthly plan</th>
          </tr>
        </thead>
        <tbody>
          ${view.members.map(
            (m) => html`
              <tr>
                <th scope="row">${m.name}</th>
                <td class="numeric">${formatPaise(m.assignedThisMonth)}</td>
                <td class="numeric">${formatPaise(m.spentThisMonth)}</td>
                <td class="numeric ${m.standing === "ahead" ? "negative" : ""}">
                  ${m.standing === "ahead"
                    ? html`${formatPaise(m.outstanding)} <span class="chip">ahead</span>`
                    : m.standing === "behind"
                      ? formatPaise(m.outstanding)
                      : html`<span class="faint">square</span>`}
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
        <strong>Ahead</strong> means they have paid for more of the household than
        they put aside for it. Nothing expires at month end — it carries forward
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
          about what you have already committed
          (${formatPaise(mine!.available as never)} is still there).
        </p>
      </section>
    `)}

    ${when(view.aheadOfUs.length > 0, () => html`
      <section class="card">
        <h2>Squaring up</h2>
        <p class="muted">
          The household is behind with
          ${view.aheadOfUs.map((m) => m.name).join(" and ")}. There are three ways
          that can end, and they are not the same thing.
        </p>
        ${view.aheadOfUs.map(
          (m) => html`
            <div style="padding:.7rem 0;border-top:1px solid var(--border)">
              <p><strong>${m.sentence}</strong></p>
              <ul class="plain">
                <li>
                  <strong>${PUT_IT_DOWN_TO_ME}</strong> — ${PUT_IT_DOWN_TO_ME_HINT}
                  ${when(Boolean(mine) && mine!.categoryId === m.categoryId, () => html`
                    <a class="button button-small"
                       href="/move?to=${m.categoryId}&amount=${m.outstanding}&month=${view.month}">
                      ${PUT_IT_DOWN_TO_ME}
                    </a>
                  `)}
                  ${when(!mine || mine.categoryId !== m.categoryId, () => html`
                    <span class="faint">— ${m.name}'s to do, from their own budget.</span>
                  `)}
                </li>
                <li>
                  <strong>${PICK_IT_UP}</strong> — ${PICK_IT_UP_HINT}
                  ${when(Boolean(mine) && mine!.categoryId !== m.categoryId, () => html`
                    <form method="post" action="/household/pick-up" style="display:inline">
                      <input type="hidden" name="envelope_id" value="${mine!.categoryId}">
                      <input type="hidden" name="amount" value="${m.outstanding / 100}">
                      <input type="hidden" name="month" value="${view.month}">
                      <button class="button-small" type="submit">
                        ${PICK_IT_UP} (${formatPaise(m.outstanding)})
                      </button>
                    </form>
                  `)}
                </li>
                <li>
                  <strong>${CALL_IT_EVEN}</strong> — ${CALL_IT_EVEN_HINT}
                  <form method="post" action="/household/call-it-even"
                        class="row" style="gap:.4rem;align-items:flex-end;margin-top:.3rem">
                    <input type="hidden" name="envelope_id" value="${m.categoryId}">
                    <input type="hidden" name="month" value="${view.month}">
                    <div class="field" style="margin:0">
                      <label style="font-size:.75rem" for="even-${m.categoryId}">How much</label>
                      <input id="even-${m.categoryId}" name="amount" class="amount-input"
                             style="max-width:8rem" type="text" inputmode="decimal"
                             value="${(m.outstanding / 100).toFixed(2)}">
                    </div>
                    <button class="button-small" type="submit">${CALL_IT_EVEN}</button>
                  </form>
                </li>
              </ul>
            </div>
          `,
        )}
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
