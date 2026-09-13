/**
 * 15 §6A · Removing a member, and what happens to what is outstanding.
 *
 * A page rather than a confirm dialog, because there is usually a figure between
 * the household and the person leaving, and the design is explicit that every
 * option is offered and the app never picks.
 */

import { html, when, type SafeHtml } from "../../http/html.ts";
import { formatPaise } from "../../core/money.ts";
import { formatMonth, type MonthKey } from "../../core/dates.ts";
import type { Departure } from "../../domain/departure.ts";

export function renderDeparture(departure: Departure, month: MonthKey): SafeHtml {
  const { memberName, outstanding, standing } = departure;

  return html`
    <h1>Removing ${memberName}</h1>
    <p class="muted">
      Nothing is deleted. Every transaction they entered keeps their name, the
      history stays exactly as it is, and adding them back later restores them —
      they pick up where they left off.
    </p>

    <section class="card">
      <h2>What removing them does</h2>
      <ul class="plain">
        <li>They can no longer sign in, and their devices are signed out.</li>
        <li>Their name stays on everything they entered (F1.6).</li>
        <li>They stop appearing when you add a transaction.</li>
      </ul>
    </section>

    ${standing === "even"
      ? html`
          <section class="card">
            <h2>Nothing is outstanding</h2>
            <p>
              ${departure.budgetId
                ? html`Their commitment to the household is square, so there is
                       nothing to settle.`
                : html`They never kept a budget of their own, so there is nothing
                       to settle.`}
            </p>
            <form method="post" action="/members/${departure.memberId}/remove">
              <button class="button-danger" type="submit">Remove ${memberName}</button>
            </form>
          </section>
        `
      : html`
          <section class="card">
            <h2>${formatPaise(outstanding)} is outstanding</h2>
            <p>
              ${standing === "overfunded"
                ? html`
                    ${memberName} has ${formatPaise(outstanding)} set aside for the
                    household that has not been spent. It is their money — they
                    promised it, and the promise ends with the arrangement.
                  `
                : html`
                    ${formatPaise(outstanding)} more of the household's spending was
                    paid out of ${memberName}'s money than they put aside for it. That
                    does not stop existing because somebody left.
                  `}
            </p>
            <p class="muted">
              ${formatMonth(month)} · choose how it ends. The app will not pick one
              for you.
            </p>

            <form method="post" action="/members/${departure.memberId}/remove">
              ${departure.options.map(
                (option) => html`
                  <div style="padding:.7rem 0;border-top:1px solid var(--border)">
                    <label class="row" style="gap:.6rem;align-items:flex-start">
                      <input type="radio" name="resolution" value="${option}" required>
                      <span>
                        <strong>${LABELS[option] ?? option}</strong>
                        <div class="faint">
                          ${EXPLAINS[option]?.(memberName, formatPaise(outstanding)) ?? ""}
                        </div>
                      </span>
                    </label>
                  </div>
                `,
              )}
              <button class="button-danger" type="submit" style="margin-top:1rem">
                Settle it and remove ${memberName}
              </button>
            </form>
          </section>
        `}

    <p><a href="/settings">Cancel and go back to settings</a></p>
  `;
}

const LABELS: Record<string, string> = {
  release: "Give it back to them",
  "family-loan": "Record it as money owed",
  "call-it-even": "Call it even",
};

const EXPLAINS: Record<string, (who: string, amount: string) => string> = {
  release: (who, amount) =>
    `${amount} returns to ${who}'s own Ready to Assign, and the household's claim ` +
    `falls by the same amount. Nothing was spent, so nothing is owed either way.`,
  "family-loan": (who, amount) =>
    `The household owes ${who} ${amount}, recorded as ordinary family lending — ` +
    `they are outside the household now, which is exactly what that is for. It ` +
    `appears on the Lending screen with the usual ways to repay or settle it.`,
  "call-it-even": (who, amount) =>
    `${who} lets the ${amount} go. It becomes spending on their side, so it lands ` +
    `in an envelope rather than vanishing, and the household is better off by it.`,
};
