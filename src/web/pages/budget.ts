/**
 * S1 · The budget screen. Everything else in the app is subordinate to this.
 *
 * The one hard layout requirement is F3.6: Ready to Assign must be visible at
 * all times, on every viewport, without scrolling — hence the sticky bar.
 */

import { html, raw, when, type SafeHtml } from "../../http/html.ts";
import { formatPaise, formatCompact, speakPaise, type Paise } from "../../core/money.ts";
import { formatMonth, addMonths, type MonthKey } from "../../core/dates.ts";
import type { BudgetView, CategoryView, GroupView } from "../viewmodel.ts";

export interface BudgetChoice {
  id: string;
  name: string;
  kind: "household" | "personal";
  current: boolean;
}

/**
 * 15 · The switcher. Absent entirely when there is one budget, so a household
 * that pools its money never sees a control for a distinction it has not made.
 */
export function renderBudgetSwitch(
  budgets: BudgetChoice[], canCreateOwn: boolean, month: string,
): SafeHtml {
  if (budgets.length < 2 && !canCreateOwn) return raw("");
  return html`
    <div class="scope-tabs" style="margin-bottom:.75rem">
      ${budgets.map(
        (b) => html`
          <a class="button-small ${b.current ? "button-primary" : ""}"
             href="/?budget=${b.id}&month=${month}">
            ${b.kind === "household" ? "Household" : b.name}
          </a>
        `,
      )}
      ${when(
        canCreateOwn,
        () => html`
          <form method="post" action="/budgets/personal" style="display:inline">
            <button class="button-small" type="submit">+ My own budget</button>
          </form>
        `,
      )}
    </div>
  `;
}

export function renderBudget(
  view: BudgetView, digest?: SafeHtml, switcher?: SafeHtml,
): SafeHtml {
  return html`
    ${switcher ?? html``}
    ${renderMonthBar(view.month, view.currentMonth)}
    ${renderReadyToAssign(view)}
    <!-- F14.3 as errata E12 leaves it: the digest on next open, in the one
         place everyone lands. -->
    ${digest ?? html``}
    ${when(view.futureCaveat, () => html`
      <p class="notice notice-info">
        This month is <strong>${view.futureCaveat}</strong> — no income has been assumed that
        hasn't arrived yet.
      </p>
    `)}
    ${renderCardWarnings(view)}
    ${when(view.groups.length > 0, () => renderFilter())}
    ${view.groups.length === 0 ? renderEmptyState() : view.groups.map((g) => renderGroup(g, view.month))}
    ${renderFooterActions(view)}
  `;
}

/**
 * B87 · Find a category without scrolling past thirty others.
 *
 * Thirty-four categories is seven screens on a phone, and the answer to "how
 * much is left for groceries" was to scroll until you saw it. Groups collapse,
 * which helps once you know where you are going, and does not help at all when
 * you are looking for one envelope in the middle of the month.
 *
 * Filtering happens on the client so it responds to each keystroke — a round
 * trip per letter would be worse than scrolling. Nothing is stored (R35); it is
 * a lens on what is already on screen, and it resets whenever the page does.
 */
function renderFilter(): SafeHtml {
  return html`
    <div class="budget-filter">
      <label class="sr-only" for="budget-filter">Find a category</label>
      <input id="budget-filter" type="search" autocomplete="off"
             placeholder="Find a category…" data-budget-filter>
      <label class="budget-filter-toggle">
        <input type="checkbox" data-budget-underfunded>
        Only what needs money
      </label>
      <p class="faint" data-budget-filter-count hidden></p>
    </div>
  `;
}

function renderMonthBar(month: MonthKey, currentMonth: MonthKey): SafeHtml {
  // F3.7: navigable back to the first month with data, and forward 24 months.
  const previous = addMonths(month, -1);
  const next = addMonths(month, 1);
  return html`
    <div class="row-between" style="margin-bottom:.75rem">
      <nav class="month-switch" aria-label="Month">
        <a href="?month=${previous}" rel="prev" aria-label="Go to ${formatMonth(previous)}">‹</a>
        <span class="month-name">${formatMonth(month)}</span>
        <a href="?month=${next}" rel="next" aria-label="Go to ${formatMonth(next)}">›</a>
      </nav>
      ${when(month !== currentMonth, () => html`
        <a class="button button-small button-quiet" href="?month=${currentMonth}">Back to this month</a>
      `)}
    </div>
  `;
}

function renderReadyToAssign(view: BudgetView): SafeHtml {
  const rta = view.monthState.readyToAssign;
  const state = view.monthState.rtaState;

  // R2's three display states. Each carries a word as well as a colour (A2).
  const wording =
    state === "negative"
      ? "You've assigned more than you have — move some back."
      : state === "zero"
        ? "Every rupee has a job."
        : "Still to assign.";

  return html`
    <section class="rta-bar rta-${state}" aria-labelledby="rta-label">
      <div class="row-between">
        <div>
          <div class="rta-label" id="rta-label">Ready to Assign</div>
          <div class="rta-figure">
            <span aria-hidden="true">${formatPaise(rta)}</span>
            <span class="sr-only">${speakPaise(rta)}</span>
          </div>
          <div class="rta-secondary muted">
            ${wording}
            <!-- F25.10: every computed figure carries an explain affordance. -->
            <a class="explain-link" data-explain href="/explain/ready-to-assign?month=${view.month}">
              How is this worked out?
            </a>
          </div>
        </div>
        <div style="text-align:right">
          ${when(view.monthState.heldForNextMonth > 0, () => html`
            <div class="chip chip-info" style="margin-bottom:.35rem">
              ${formatPaise(view.monthState.heldForNextMonth)} held for next month
            </div>
          `)}
          <div class="faint">${view.buffer.reading}</div>
        </div>
      </div>

      ${when(view.underfunded.categoryCount > 0, () => html`
        <p class="rta-secondary">
          <a href="#first-underfunded">
            ${formatPaise(view.underfunded.amount)} underfunded across
            ${view.underfunded.categoryCount}
            ${view.underfunded.categoryCount === 1 ? "category" : "categories"}
          </a>
          ·
          <a href="/auto-assign?month=${view.month}">Auto-assign</a>
          ·
          <!-- F3.9: budget like last month, then adjust. -->
          <button class="linkish" type="submit" form="fill-last-month">Fill from last month</button>
        </p>
        <form id="fill-last-month" method="post" action="/copy-last-month" hidden>
          <input type="hidden" name="month" value="${view.month}">
        </form>
      `)}

      ${when(view.fullyFunded, () => html`
        <p class="notice notice-success" style="margin:.6rem 0 0">
          Fully funded — every target met and nothing left to assign.
        </p>
      `)}
    </section>
  `;
}

/** R6 / F8.3: the shortfall stated in words, not as a bare number (03 §7). */
function renderCardWarnings(view: BudgetView): SafeHtml {
  const unfunded = view.cards.filter((c) => c.unfunded > 0);
  if (unfunded.length === 0) return raw("");

  return html`
    ${unfunded.map((card) => {
      const category = [...view.categories.values()].find((c) => c.paymentAccountId === card.accountId);
      return html`
        <p class="notice notice-warning">
          <strong>${formatPaise(card.unfunded)}</strong> of your ${category?.name ?? "card"}
          balance isn't funded yet.
          <a href="/move?to=${category?.id ?? ""}&amount=${card.unfunded}&month=${view.month}">
            Fund it
          </a>
        </p>
      `;
    })}
  `;
}

function renderGroup(group: GroupView, month: MonthKey): SafeHtml {
  return html`
    <details class="category-group" open>
      <summary>
        <span>${group.name}</span>
        <span class="group-totals">
          <span>Assigned ${formatCompact(group.assigned)}</span>
          <span>Balance ${formatCompact(group.balance)}</span>
        </span>
      </summary>
      ${group.categories.map((c) => renderCategoryRow(c, month))}
      ${when(group.categories.length === 0, () => html`
        <p class="faint" style="padding:.75rem 1rem">Nothing in this group yet.</p>
      `)}
    </details>
  `;
}

function renderCategoryRow(category: CategoryView, month: MonthKey): SafeHtml {
  const { state, progress } = category;
  const anchor = progress && progress.underfunded > 0 ? ' id="first-underfunded"' : "";
  // B87 · What "needs money" means, decided here rather than inferred from a
  // class name in the client: short of its target, or already overspent.
  const needsMoney = (progress?.underfunded ?? 0) > 0 || state.balance < 0;

  return html`
    <div class="category-row ${category.stateClass}"${raw(anchor)}
         data-category-name="${category.name}"${raw(needsMoney ? " data-needs-money" : "")}>
      <div class="category-name">
        <!-- B55: the name drills into this category's transactions (F10.2), a
             real page. "Explain this number" stays on the balance, as a popover.
             (It used to link straight to the bare explain fragment, which
             navigated to an unstyled page.) -->
        <a href="/query?category=${category.id}&period=this-month">${category.name}</a>
      </div>

      <div class="category-meta">
        <span class="chip">${category.stateLabel}</span>
        ${when(progress, () => renderTargetBar(progress!))}
        ${when(category.isPaymentCategory, () => html`
          <span class="faint">Settles this card's balance</span>
        `)}
        ${when(category.needsCover, () => html`
          <!-- R5: no more than two taps from a red category. -->
          <a class="button button-small button-danger"
             href="/move?to=${category.id}&amount=${-state.balance}&month=${month}">
            Cover ${formatPaise(-state.balance)}
          </a>
        `)}
      </div>

      <div class="assign-cell">
        <form method="post" action="/assign" data-reload-on-success="true">
          <input type="hidden" name="month" value="${month}">
          <input type="hidden" name="category_id" value="${category.id}">
          <label class="sr-only" for="assign-${category.id}">
            Assigned to ${category.name}
          </label>
          <input id="assign-${category.id}" name="amount" data-assign-input
                 type="text" inputmode="decimal" autocomplete="off"
                 value="${state.assigned === 0 ? "" : (state.assigned / 100).toFixed(2)}"
                 placeholder="0.00">
          <noscript><button class="button-small" type="submit">Assign</button></noscript>
        </form>
      </div>

      <div class="category-balance">
        <a class="explain-link" data-explain
           href="/explain/category/${category.id}?month=${month}"
           title="${formatPaise(state.balance)}">
          <span aria-hidden="true">${formatPaise(state.balance)}</span>
          <span class="sr-only">Balance ${speakPaise(state.balance)}. Explain this number.</span>
        </a>
        <div class="faint">Spent ${formatPaise(-state.activity)}</div>
      </div>
    </div>
  `;
}

function renderTargetBar(progress: { needed: Paise; underfunded: Paise; state: string }): SafeHtml {
  const assigned = progress.needed - progress.underfunded;
  const percent = progress.needed > 0 ? Math.min(100, Math.round((assigned / progress.needed) * 100)) : 100;
  const className =
    progress.state === "unfunded" ? "unfunded" : progress.state === "partial" ? "partial" : "";

  return html`
    <span class="target-bar ${className}" role="img"
          aria-label="${percent}% of this month's target assigned">
      <span style="width:${percent}%"></span>
    </span>
    <span class="faint">
      ${formatPaise(assigned)} of ${formatPaise(progress.needed)}
    </span>
  `;
}

function renderFooterActions(view: BudgetView): SafeHtml {
  return html`
    <div class="card">
      <div class="row" style="flex-wrap:wrap">
        <a class="button" href="/auto-assign?month=${view.month}">Auto-assign this month</a>
        <a class="button" href="/move?month=${view.month}">Move money</a>
        <a class="button" href="/hold?month=${view.month}">Hold for next month</a>
        <a class="button button-quiet" href="/categories">Manage categories</a>
      </div>
    </div>
  `;
}

/**
 * 03 §5: the empty budget is not a blank grid. One call to action, with the
 * starting-template offer.
 */
function renderEmptyState(): SafeHtml {
  return html`
    <div class="card empty-state">
      <div class="empty-icon" aria-hidden="true">◧</div>
      <h2>Nothing to budget yet</h2>
      <p>Add your first account and its current balance, and Ready to Assign becomes a real number.</p>
      <p>
        <a class="button button-primary" href="/accounts/new">Add your first account</a>
        <a class="button" href="/setup">Start from a template</a>
      </p>
    </div>
  `;
}
