/**
 * N6 · One control for one question: *whose money am I looking at?*
 *
 * The app had two. The header and the sidebar carry a row of pills — Household,
 * Ravi, Priya — that says which budget the screen is about. Reports and Query
 * ask the same question with a dropdown, in a card, in different words ("The
 * household's", "Ravi's"), in a different place on the page.
 *
 * `16` settled the *behaviour* deliberately and correctly: those two screens
 * offer every scope rather than picking one, because "what did we spend on
 * groceries", "what did I spend" and "what did all of it come to" are three
 * questions and answering one silently is wrong twice as often as it is right.
 * Nothing here changes that. What changes is that the extra scope is an extra
 * pill — **Everything** — rather than an extra kind of control, so somebody who
 * learns one finds the other.
 *
 * Links rather than a select: the reports dropdown needed `onchange` to submit
 * itself, and a control that does nothing without scripting is not a control.
 */

import { html, raw, when, type SafeHtml } from "../http/html.ts";

export interface ScopeBudget {
  id: string;
  name: string;
  kind: string;
}

/** The word for one budget, used everywhere the switch appears. */
export function scopeName(budget: ScopeBudget): string {
  return budget.kind === "household" ? "Household" : budget.name;
}

export function renderScopeSwitch(opts: {
  budgets: ScopeBudget[];
  /** The budget in force, or "all" where every scope is offered. */
  current: string | null;
  /** Where each pill points. Takes a budget id, or "all". */
  href: (scope: string) => string;
  /** Whether to offer "Everything" — true on the screens `16` opens up. */
  everything?: boolean;
  label: string;
  className?: string;
}): SafeHtml {
  const scopes = [
    ...(opts.everything ? [{ id: "all", label: "Everything" }] : []),
    ...opts.budgets.map((b) => ({ id: b.id, label: scopeName(b) })),
  ];
  const current = opts.current ?? (opts.everything ? "all" : null);

  return html`
    <nav class="${opts.className ?? "scope-switch"}" aria-label="${opts.label}">
      ${scopes.map((scope) => html`
        <a href="${opts.href(scope.id)}"
           ${raw(scope.id === current ? 'aria-current="true"' : "")}>
          <!--
            A2 · A word and a mark, never colour alone. On a phone it also tells
            this apart from the member link at the other end of the header, which
            is the same name twice: one meaning "whose money", one "who you are".
          -->
          <span aria-hidden="true">${scope.id === current ? "●" : "○"}</span>
          ${scope.label}
          ${when(scope.id === current, () => html`<span class="sr-only">(selected)</span>`)}
        </a>
      `)}
    </nav>
  `;
}
