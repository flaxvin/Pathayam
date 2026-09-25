/**
 * S3 · Add transaction, plus the move-money, auto-assign and hold sheets, and
 * the "explain this number" panel (F25.10).
 */

import { html, raw, when, type SafeHtml, escape } from "../../http/html.ts";
import { renderCategoryLines } from "./category-lines.ts";
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
  /** 15 · The budgets whose envelopes are on offer, so the picker says whose. */
  budgets?: { id: string; name: string; kind: string }[];
  /** H2 · Who could have spent it. Empty for a one-person household. */
  members?: { id: string; name: string }[];
  /** Defaults to whoever is entering it, which is right almost every time. */
  defaultSpenderId?: string | null;
}): SafeHtml {
  const { accounts, categories, payees, defaultAccountId, today } = opts;
  const budgets = opts.budgets ?? [];
  const members = opts.members ?? [];

  /*
   * Whose name shows first. The account's holder when it has one — a card in
   * Priya's name was almost certainly used by Priya (R6.e) — and otherwise
   * whoever is entering it.
   */
  const defaultAccount = accounts.find((a) => a.id === defaultAccountId);
  const defaultSpender =
    (defaultAccount?.holder_member_id && members.some((m) => m.id === defaultAccount.holder_member_id)
      ? defaultAccount.holder_member_id
      : opts.defaultSpenderId) ?? members[0]?.id ?? null;

  /*
   * 15 · Which budget an envelope belongs to matters at the moment of filing,
   * because filing across budgets is what raises a claim between them. An
   * unlabelled list of thirty envelopes from two budgets cannot say that, so the
   * options are grouped and each group is named.
   */
  const spendable = categories.filter((c) => !c.isPaymentCategory && !c.commitsToBudgetId && !c.hidden);
  const budgetLabel = (id: string | null): string => {
    const budget = budgets.find((b) => b.id === id);
    if (!budget) return "Other envelopes";
    return budget.kind === "household" ? "The household budget" : `${budget.name}'s budget`;
  };
  const grouped = budgets.length > 1
    ? budgets
        .map((b) => ({ label: budgetLabel(b.id), items: spendable.filter((c) => c.budgetId === b.id) }))
        .filter((g) => g.items.length > 0)
    : [];

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
        <!--
          B82 · The usual category rides along on each option.
          payeeStats has worked out where a payee's money normally goes since
          the beginning, and this form has been handed that answer and thrown it
          away — leaving the household to pick "Groceries" for the hundredth
          time on the screen they use most. The client reads this attribute and
          fills the category in, and never overrides a choice already made.
        -->
        <datalist id="payee-options">
          ${payees.map(
            (p) => html`
              <option value="${p.name}"
                      ${raw(p.usualCategoryId ? `data-category="${escape(p.usualCategoryId)}"` : "")}>
                ${p.lastAmount !== null
                  ? `last: ${formatPaise(Math.abs(p.lastAmount))}${p.lastDate ? ` on ${formatDate(p.lastDate)}` : ""}`
                  : ""}
              </option>
            `,
          )}
        </datalist>
      </div>

      <!--
        B99 · Money out names its envelope; money in does not have to.
        "I'll sort it later" was an option here and later mostly never came:
        three years of real use left a standing queue of expenses with no
        envelope behind them. The client drops the requirement when the
        direction is switched.

        There is no separate "category" field any more. The first line *is* the
        envelope, and it carries no amount — whatever the extra lines do not
        claim stays on it. A box that silently meant nothing while a split was
        open was the source of a long run of faults.
      -->
      ${renderCategoryLines({
        label: "Envelope",
        required: true,
        requiresCategory: true,
        categories: spendable.map((c) => ({
          id: c.id, name: c.name, balance: c.state.balance,
        })),
        hint: html`
          Each envelope shows what it holds, so you can see the consequence while
          entering. Money coming in doesn't need one — it lands in Ready to Assign.
        `,
      })}
      ${when(grouped.length > 1, () => html`
        <!--
          15 §3.4 · What a cross-budget filing does, said when it is chosen
          rather than after it is refused. Whether an account is private has
          nothing to do with this: privacy decides who can see the account,
          and the budget decides where its spending lands.
        -->
        <p class="field-hint" data-cross-budget hidden></p>
      `)}

      <div class="grid-2">
        <div class="field">
          <label for="account_id">Account</label>
          <select id="account_id" name="account_id" required>
            ${accounts.map(
              (a) => html`
                <option value="${a.id}" ${raw(a.id === defaultAccountId ? "selected" : "")}
                        data-holder="${a.holder_member_id ?? ""}"
                        data-budget="${a.budget_id ?? ""}">
                  ${a.nickname || a.name}
                </option>
              `,
            )}
          </select>
        </div>
        <div class="field">
          <label for="date">Date</label>
          <input id="date" name="date" type="date" autocomplete="off"
                 value="${today}">
        </div>
      </div>

      ${when(members.length > 1, () => html`
        <!--
          H2 · Who spent it, in front of you rather than behind a disclosure.
          On a shared account or a shared card it is the one thing the ledger
          cannot work out for itself, and asking later never happens. It defaults
          to whoever is entering it, which is right almost every time.
        -->
        <div class="field">
          <label for="owner_member_id">Who spent it</label>
          <!--
            A name, not a rule. "Whoever the card says — otherwise me" was
            accurate and useless: it asked the reader to work out who that would
            be. The right person is shown selected, and it follows the account —
            picking somebody's card selects them (R6.e), and anything else selects
            you. Overriding it is one more click and is still a deliberate act.
          -->
          <select id="owner_member_id" name="owner_member_id"
                  data-spender data-default="${opts.defaultSpenderId ?? ""}">
            ${members.map(
              (m) => html`
                <option value="${m.id}"
                        ${raw(m.id === defaultSpender ? "selected" : "")}>
                  ${m.name}
                </option>
              `,
            )}
          </select>
          <p class="field-hint">
            Follows the account — a card in somebody's name is attributed to them.
            Change it when one of you paid for the other.
          </p>
        </div>
      `)}

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
          <input id="tags" name="tags" autocomplete="off" placeholder="kerala-oct, diwali">
          <p class="field-hint">Comma separated. A tag works as an ad-hoc budget without touching your categories.</p>
        </div>
        <div class="field">
          <label><input type="checkbox" name="cleared" value="1"> Already cleared the bank</label>
        </div>
        <!--
          B84 · Money you have fronted and expect back.
          The column, and the domain support for it, were written at the start
          and no screen ever set them — so the hint on the tags field above used
          to suggest typing the word "reimbursable" as a tag instead, working
          around the app's own field. A tag cannot be settled; this can.
        -->
        <div class="field">
          <label>
            <input type="checkbox" name="reimbursable" value="1">
            Someone owes me this back
          </label>
          <p class="field-hint">
            It still leaves your envelope now. Review lists what is outstanding
            until the money comes back.
          </p>
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

/**
 * B51 · Record a transfer between two accounts.
 *
 * The POST handler shipped but nothing rendered a form for it — the only link,
 * on the add-transaction page, went to a route with no GET, so it 405'd.
 * Transfers are load-bearing (credit-card payments, asset purchases, family
 * lending), so this is the form that was missing. `defaultTo` / `defaultFrom`
 * honour the `?to=` / `?from=` query the "Record a payment" links pass.
 */
export function renderTransfer(opts: {
  accounts: Account[];
  defaultFrom: string | null;
  defaultTo: string | null;
  today: string;
  /** Envelopes a bank charge can be filed into, if the bank took one. */
  categories?: { id: string; name: string }[];
  error?: string | null;
}): SafeHtml {
  const { accounts, defaultFrom, defaultTo, today, categories = [] } = opts;

  if (accounts.length < 2) {
    return html`
      <div class="card empty-state">
        <div class="empty-icon" aria-hidden="true">⇄</div>
        <h2>A transfer needs two accounts</h2>
        <p>Add another account and you can move money between them.</p>
        <p><a class="button button-primary" href="/accounts/new">Add an account</a></p>
      </div>
    `;
  }

  const accountOptions = (selected: string | null) =>
    accounts.map(
      (a) => html`
        <option value="${a.id}" ${raw(a.id === selected ? "selected" : "")}>
          ${a.nickname || a.name}
        </option>
      `,
    );

  return html`
    <h1>Record a transfer</h1>
    ${when(opts.error, () => html`<p class="notice notice-error">${opts.error}</p>`)}
    <p class="faint">
      Money leaves one account and lands in another. No spending category is touched —
      paying a credit card off a bank account is exactly this.
    </p>

    <form method="post" action="/transfer" class="card">
      <div class="field">
        <label for="amount">Amount</label>
        <input id="amount" name="amount" class="amount-input" type="text"
               inputmode="decimal" autocomplete="off" required autofocus placeholder="0.00">
      </div>

      <div class="grid-2">
        <div class="field">
          <label for="from_account_id">From</label>
          <select id="from_account_id" name="from_account_id" required>
            ${accountOptions(defaultFrom)}
          </select>
        </div>
        <div class="field">
          <label for="to_account_id">To</label>
          <select id="to_account_id" name="to_account_id" required>
            ${accountOptions(defaultTo)}
          </select>
        </div>
      </div>

      <div class="field">
        <label for="date">Date</label>
        <input id="date" name="date" type="date" autocomplete="off"
               value="${today}">
      </div>

      ${categories.length > 0
        ? html`
            <details class="field">
              <summary>The bank charged for this</summary>
              <p class="field-hint">
                An IMPS fee, a demat charge, the markup on a conversion. It comes
                out of the sending account on top of the amount above, so the
                balance still matches the statement, and it needs an envelope
                because it is spending like any other.
              </p>
              <div class="row" style="gap:1rem;flex-wrap:wrap">
                <div class="field" style="margin:0">
                  <label for="fee_amount">Charge</label>
                  <input id="fee_amount" name="fee_amount" inputmode="decimal"
                         placeholder="0.00" style="max-width:8rem">
                </div>
                <div class="field" style="margin:0">
                  <label for="fee_category_id">From envelope</label>
                  <select id="fee_category_id" name="fee_category_id">
                    ${categories.map((c) => html`<option value="${c.id}">${c.name}</option>`)}
                  </select>
                </div>
              </div>
            </details>
          `
        : html``}

      <button class="button-primary" type="submit">Record transfer</button>
      <a class="button button-quiet" href="/accounts">Cancel</a>
    </form>
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
  readyToAssign: Paise;
  error?: string | null;
}): SafeHtml {
  const target = opts.categories.find((c) => c.id === opts.toCategoryId);
  const rtaAvailable = opts.readyToAssign > 0;

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

      ${when(rtaAvailable || opts.suggestions.length > 0, () => html`
        <div class="field">
          <label>Suggested sources</label>
          <div class="row" style="flex-wrap:wrap">
            ${when(rtaAvailable, () => html`
              <!-- B55: Ready to Assign is a source too — funding a category from
                   it is just assigning unassigned income. -->
              <button type="submit" name="from_category_id" value="rta"
                      class="button-small button-primary" data-no-retry="true">
                Ready to Assign · ${formatPaise(opts.readyToAssign)}
              </button>
            `)}
            ${opts.suggestions.map(
              (s) => html`
                <button type="submit" name="from_category_id" value="${s.categoryId}"
                        class="button-small" data-no-retry="true">
                  ${s.reason} · ${formatPaise(s.available)}
                </button>
              `,
            )}
          </div>
          <p class="field-hint">Suggestions only — you can fund from Ready to Assign or move from any category.</p>
        </div>
      `)}

      <div class="grid-2">
        <div class="field">
          <label for="from_category_id">From</label>
          <select id="from_category_id" name="from_category_id" required>
            ${when(rtaAvailable, () => html`
              <option value="rta">Ready to Assign — ${formatPaise(opts.readyToAssign)}</option>
            `)}
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
        Moving between categories doesn't change Ready to Assign — the same rupees
        do a different job. Funding <em>from</em> Ready to Assign does reduce it: that
        is assigning income that had no job yet.
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
  budgetId: string;
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
            : "No category is short of its target. Set a target on a category and auto-assign will fund it."}
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

      <form method="post" action="/auto-assign?budget=${opts.budgetId}" style="margin-top:1rem">
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
  budgetId: string;
  currentlyHeld: Paise;
  readyToAssign: Paise;
}): SafeHtml {
  return html`
    <h1>Hold money for next month</h1>
    <p class="muted">
      This is how you get to spending last month's income. Held money leaves this month's
      Ready to Assign and appears at the top of next month's.
    </p>

    <form method="post" action="/hold?budget=${opts.budgetId}" class="card">
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
      <h1>That page doesn't exist</h1>
      <p><a class="button" href="/">Back to the budget</a></p>
    </div>
  `;
}
