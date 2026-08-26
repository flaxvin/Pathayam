/**
 * S3 · Add transaction, plus the move-money, auto-assign and hold sheets, and
 * the "explain this number" panel (F25.10).
 */

import { html, raw, when, type SafeHtml } from "../../http/html.ts";
import { formatPaise, type Paise } from "../../core/money.ts";
import { formatDate, formatMonth, type MonthKey } from "../../core/dates.ts";
import type { Account } from "../../domain/accounts.ts";
import type { CategoryView } from "../viewmodel.ts";
import type { CoverSource, AutoAssignPlan } from "../../engine/engine.ts";
import type { LoggedEvent } from "../../core/events.ts";

export interface PayeeSuggestion {
  id: string;
  name: string;
  usualCategoryId: string | null;
  lastAmount: Paise | null;
  lastDate: string | null;
}

/**
 * S3 · The field order is deliberate: amount, payee, category, account, date.
 * That is the order people think in, and J2's five-second target depends on
 * not making them hunt.
 */
export function renderAddTransaction(opts: {
  accounts: Account[];
  categories: CategoryView[];
  payees: PayeeSuggestion[];
  defaultAccountId: string | null;
  today: string;
  error?: string | null;
}): SafeHtml {
  const { accounts, categories, payees, defaultAccountId, today } = opts;

  if (accounts.length === 0) {
    return html`
      <div class="card empty-state">
        <div class="empty-icon" aria-hidden="true">＋</div>
        <h2>Add an account first</h2>
        <p>A transaction has to live somewhere.</p>
        <p><a class="button button-primary" href="/accounts/new">Add an account</a></p>
      </div>
    `;
  }

  return html`
    <h1>Add a transaction</h1>
    ${when(opts.error, () => html`<p class="notice notice-error">${opts.error}</p>`)}

    <form method="post" action="/add" class="card">
      <div class="field">
        <label for="amount">Amount</label>
        <!-- A7: numeric keypad with a decimal. F4.10: expressions are accepted. -->
        <input id="amount" name="amount" class="amount-input" type="text"
               inputmode="decimal" autocomplete="off" required autofocus
               placeholder="0.00">
        <p class="field-hint">
          Sums work too — type <code>450+120*2</code> and it will be worked out before saving.
        </p>
      </div>

      <div class="field">
        <label for="direction">Direction</label>
        <select id="direction" name="direction">
          <option value="out">Money out</option>
          <option value="in">Money in</option>
        </select>
      </div>

      <div class="field">
        <label for="payee">Payee</label>
        <input id="payee" name="payee" list="payee-options" autocomplete="off"
               placeholder="Start typing…">
        <datalist id="payee-options">
          ${payees.map(
            (p) => html`
              <option value="${p.name}">
                ${p.lastAmount !== null
                  ? `last: ${formatPaise(Math.abs(p.lastAmount))}${p.lastDate ? ` on ${formatDate(p.lastDate)}` : ""}`
                  : ""}
              </option>
            `,
          )}
        </datalist>
      </div>

      <div class="field">
        <label for="category_id">Category</label>
        <select id="category_id" name="category_id">
          <option value="">Uncategorised — I'll sort it later</option>
          ${categories
            // R6: the payment envelope is driven by the card's own transactions.
            // Letting it be chosen directly would double-count the spend.
            .filter((c) => !c.isPaymentCategory && !c.hidden)
            .map(
              (c) => html`
                <option value="${c.id}">
                  ${c.name} — ${formatPaise(c.state.balance)} left
                </option>
              `,
            )}
        </select>
        <p class="field-hint">
          Each category shows what it holds, so you can see the consequence while entering.
        </p>
      </div>

      <div class="grid-2">
        <div class="field">
          <label for="account_id">Account</label>
          <select id="account_id" name="account_id" required>
            ${accounts.map(
              (a) => html`
                <option value="${a.id}" ${raw(a.id === defaultAccountId ? "selected" : "")}>
                  ${a.nickname || a.name}
                </option>
              `,
            )}
          </select>
        </div>
        <div class="field">
          <label for="date">Date</label>
          <input id="date" name="date" type="text" autocomplete="off"
                 value="${formatDate(today)}" placeholder="DD-MM-YYYY">
        </div>
      </div>

      <details>
        <summary style="min-height:44px;display:flex;align-items:center;cursor:pointer">
          More — memo, tags, cleared
        </summary>
        <div class="field" style="margin-top:.75rem">
          <label for="memo">Memo</label>
          <input id="memo" name="memo" autocomplete="off">
        </div>
        <div class="field">
          <label for="tags">Tags</label>
          <input id="tags" name="tags" autocomplete="off" placeholder="kerala-oct, reimbursable">
          <p class="field-hint">Comma separated. A tag works as an ad-hoc budget without touching your categories.</p>
        </div>
        <div class="field">
          <label><input type="checkbox" name="cleared" value="1"> Already cleared the bank</label>
        </div>
      </details>

      <button class="button-primary" type="submit">Save</button>
      <a class="button button-quiet" href="/">Cancel</a>
    </form>

    <p class="faint">
      Looking to move money between two accounts? <a href="/transfer">Record a transfer</a> instead —
      paying a credit card is a transfer, and it won't touch any spending category.
    </p>
  `;
}

// ---------------------------------------------------------------------------
// R5 · Move money
// ---------------------------------------------------------------------------

export function renderMoveMoney(opts: {
  month: MonthKey;
  categories: CategoryView[];
  toCategoryId: string | null;
  amount: Paise | null;
  suggestions: CoverSource[];
  error?: string | null;
}): SafeHtml {
  const target = opts.categories.find((c) => c.id === opts.toCategoryId);

  return html`
    <h1>Move money</h1>
    ${when(opts.error, () => html`<p class="notice notice-error">${opts.error}</p>`)}

    ${when(target && target.state.balance < 0, () => html`
      <!-- 03 §7: never scold. State the number and offer the next step. -->
      <p class="notice notice-warning">
        ${target!.name} is over by ${formatPaise(-target!.state.balance)} —
        cover it from another category?
      </p>
    `)}

    <form method="post" action="/move" class="card">
      <input type="hidden" name="month" value="${opts.month}">

      ${when(opts.suggestions.length > 0, () => html`
        <div class="field">
          <label>Suggested sources</label>
          <div class="row" style="flex-wrap:wrap">
            ${opts.suggestions.map(
              (s) => html`
                <button type="submit" name="from_category_id" value="${s.categoryId}"
                        class="button-small" data-no-retry="true">
                  ${s.reason} · ${formatPaise(s.available)}
                </button>
              `,
            )}
          </div>
          <p class="field-hint">Suggestions only — you can move money from anywhere to anywhere.</p>
        </div>
      `)}

      <div class="grid-2">
        <div class="field">
          <label for="from_category_id">From</label>
          <select id="from_category_id" name="from_category_id" required>
            ${opts.categories.map(
              (c) => html`
                <option value="${c.id}">${c.name} — ${formatPaise(c.state.balance)}</option>
              `,
            )}
          </select>
        </div>
        <div class="field">
          <label for="to_category_id">To</label>
          <select id="to_category_id" name="to_category_id" required>
            ${opts.categories.map(
              (c) => html`
                <option value="${c.id}" ${raw(c.id === opts.toCategoryId ? "selected" : "")}>
                  ${c.name} — ${formatPaise(c.state.balance)}
                </option>
              `,
            )}
          </select>
        </div>
      </div>

      <div class="field">
        <label for="move-amount">Amount</label>
        <input id="move-amount" name="amount" class="amount-input" type="text" inputmode="decimal"
               value="${opts.amount ? (opts.amount / 100).toFixed(2) : ""}" required>
      </div>

      <p class="field-hint">
        Moving money between categories doesn't change Ready to Assign — the same rupees
        are simply doing a different job.
      </p>

      <button class="button-primary" type="submit">Move it</button>
      <a class="button button-quiet" href="/?month=${opts.month}">Cancel</a>
    </form>
  `;
}

// ---------------------------------------------------------------------------
// R9 · Auto-assign, with the preview R9 requires before anything is applied
// ---------------------------------------------------------------------------

export function renderAutoAssignPreview(opts: {
  month: MonthKey;
  plan: AutoAssignPlan;
  categoryNames: Map<string, string>;
}): SafeHtml {
  const { plan, month } = opts;

  if (plan.proposals.length === 0) {
    return html`
      <h1>Auto-assign · ${formatMonth(month)}</h1>
      <div class="card empty-state">
        <h2>Nothing to assign</h2>
        <p>
          ${plan.rtaBefore <= 0
            ? "There's no money left to assign this month."
            : "No categories have an auto-assign rule yet. Set one on a category to have it filled automatically."}
        </p>
        <p><a class="button" href="/?month=${month}">Back to the budget</a></p>
      </div>
    `;
  }

  return html`
    <h1>Auto-assign · ${formatMonth(month)}</h1>
    <p class="muted">Nothing is assigned until you apply this.</p>

    <div class="card">
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Category</th>
              <th scope="col">Why</th>
              <th scope="col" class="num">Now</th>
              <th scope="col" class="num">After</th>
              <th scope="col" class="num">Change</th>
            </tr>
          </thead>
          <tbody>
            ${plan.proposals.map(
              (p) => html`
                <tr>
                  <td>${opts.categoryNames.get(p.categoryId) ?? p.categoryId}</td>
                  <td class="faint">
                    ${p.reason}
                    ${when(p.limitedByAvailableFunds, () => html`
                      <span class="chip chip-warning">limited by what's left</span>
                    `)}
                  </td>
                  <td class="num amount">${formatPaise(p.from)}</td>
                  <td class="num amount">${formatPaise(p.to)}</td>
                  <td class="num amount amount-positive">+${formatPaise(p.delta)}</td>
                </tr>
              `,
            )}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" colspan="4">Ready to Assign after this</th>
              <td class="num amount"><strong>${formatPaise(plan.rtaAfter)}</strong></td>
            </tr>
          </tfoot>
        </table>
      </div>

      <form method="post" action="/auto-assign" style="margin-top:1rem">
        <input type="hidden" name="month" value="${month}">
        <button class="button-primary" type="submit">
          Assign ${formatPaise(plan.totalAssigned)}
        </button>
        <a class="button button-quiet" href="/?month=${month}">Cancel</a>
      </form>
      <p class="field-hint">You can undo this in one action afterwards.</p>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// R11 · Hold income for next month
// ---------------------------------------------------------------------------

export function renderHold(opts: {
  month: MonthKey;
  currentlyHeld: Paise;
  readyToAssign: Paise;
}): SafeHtml {
  return html`
    <h1>Hold money for next month</h1>
    <p class="muted">
      This is how you get to spending last month's income. Held money leaves this month's
      Ready to Assign and appears at the top of next month's.
    </p>

    <form method="post" action="/hold" class="card">
      <input type="hidden" name="month" value="${opts.month}">
      <div class="field">
        <label for="hold-amount">Hold for ${formatMonth(nextMonthOf(opts.month))}</label>
        <input id="hold-amount" name="amount" class="amount-input" type="text" inputmode="decimal"
               value="${opts.currentlyHeld ? (opts.currentlyHeld / 100).toFixed(2) : ""}"
               placeholder="0.00">
        <p class="field-hint">
          ${formatPaise(opts.readyToAssign)} is currently ready to assign.
          Set this to zero to release it again.
        </p>
      </div>
      <button class="button-primary" type="submit">Hold it</button>
      <a class="button button-quiet" href="/?month=${opts.month}">Cancel</a>
    </form>
  `;
}

function nextMonthOf(month: MonthKey): MonthKey {
  const year = Number(month.slice(0, 4));
  const m = Number(month.slice(5));
  return m === 12 ? `${year + 1}-01` : `${year}-${String(m + 1).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// F25.10 · "Explain this number"
// ---------------------------------------------------------------------------

export interface ExplainLine {
  when: string;
  what: string;
  who: string;
  amount?: Paise;
}

/**
 * J22: *"why do I have ₹4,000 less than I thought?"* — a chronological list,
 * each line attributed. Rendered as a fragment; the client puts it in a dialog.
 */
export function renderExplain(opts: {
  title: string;
  figure: Paise;
  summary: string;
  lines: ExplainLine[];
}): SafeHtml {
  return html`
    <h2>${opts.title}</h2>
    <p class="amount" style="font-size:1.5rem;font-weight:700">${formatPaise(opts.figure)}</p>
    <p class="muted">${opts.summary}</p>
    ${opts.lines.length === 0
      ? html`<p class="faint">Nothing has affected this figure yet.</p>`
      : html`
          <ul class="explain-list">
            ${opts.lines.map(
              (line) => html`
                <li>
                  <div>${line.what}</div>
                  <div class="explain-when">${line.when} · ${line.who}</div>
                </li>
              `,
            )}
          </ul>
        `}
  `;
}

/** Turn an event into a line of the explanation. */
export function explainLineFor(event: LoggedEvent, memberName: (id: string | null) => string): ExplainLine {
  const who = event.realMemberId
    ? `${memberName(event.actorMemberId)} (by ${memberName(event.realMemberId)})`
    : event.source === "rule"
      ? `rule "${event.sourceDetail ?? "unnamed"}"`
      : event.source === "import"
        ? "an import"
        : memberName(event.actorMemberId);

  return {
    when: formatDate(event.at.slice(0, 10)),
    what: event.summary ?? `${event.action} ${event.entity}`,
    who,
  };
}

export function renderNotFound(): SafeHtml {
  return html`
    <div class="card empty-state">
      <div class="empty-icon" aria-hidden="true">◌</div>
      <h2>That page doesn't exist</h2>
      <p><a class="button" href="/">Back to the budget</a></p>
    </div>
  `;
}
