/**
 * S2 · Accounts, the account register, and the credit-card panel.
 */

import { html, raw, when, type SafeHtml } from "../../http/html.ts";
import { formatPaise, speakPaise, type Paise } from "../../core/money.ts";
import { formatDate, daysBetween, todayIST, type IsoDate } from "../../core/dates.ts";
import type { Account, Card, CardStatement } from "../../domain/accounts.ts";
import { ACCOUNT_SUBTYPES, SUBTYPE_LABELS, MANAGED_SUBTYPES } from "../../domain/accounts.ts";
import { sparkline } from "../charts.ts";
import type { AccountBalances } from "../../engine/repository.ts";
import type { CardFunding } from "../../engine/engine.ts";

export interface AccountRow {
  account: Account;
  /** H2 · Whose account it is, when the household has said. */
  holderName?: string | null;
  balances: AccountBalances;
  unclearedCount: number;
  lastReconciled: IsoDate | null;
  checkpointBroken: boolean;
  funding?: CardFunding | null;
  dueDate?: IsoDate | null;
  /** S15 · Recent running balance, oldest→newest, for an inline sparkline. */
  balanceSeries?: number[];
}

export function renderAccountList(rows: AccountRow[]): SafeHtml {
  const budget = rows.filter((r) => r.account.kind === "budget");
  const credit = rows.filter((r) => r.account.kind === "credit");
  const tracking = rows.filter((r) => r.account.kind === "tracking");

  const budgetTotal = budget.reduce((sum, r) => sum + r.balances.working, 0);
  const owed = [...credit, ...tracking].reduce(
    (sum, r) => sum + Math.min(0, r.balances.working), 0,
  );

  if (rows.length === 0) {
    return html`
      <div class="card empty-state">
        <div class="empty-icon" aria-hidden="true">▤</div>
        <h2>No accounts yet</h2>
        <p>Add the account your salary lands in first — everything else can follow.</p>
        <p><a class="button button-primary" href="/accounts/new">Add an account</a></p>
      </div>
    `;
  }

  return html`
    <div class="row-between" style="margin-bottom:1rem">
      <h1>Accounts</h1>
      <a class="button button-primary" href="/accounts/new">Add an account</a>
    </div>

    ${renderSection("Budget accounts", budget, "These fund your envelopes.")}
    ${renderSection("Credit accounts", credit, "Spending here creates a liability and reserves envelope money.")}
    ${renderSection("Tracking accounts", tracking, "Balances you want to see. These never fund the budget.")}

    <div class="card">
      <div class="row-between">
        <span class="muted">Total in budget accounts</span>
        <strong class="amount">${formatPaise(budgetTotal)}</strong>
      </div>
      <div class="row-between">
        <span class="muted">Total owed</span>
        <strong class="amount amount-negative">${formatPaise(owed)}</strong>
      </div>
    </div>
  `;
}

function renderSection(title: string, rows: AccountRow[], blurb: string): SafeHtml {
  if (rows.length === 0) return raw("");
  return html`
    <section class="card">
      <h2>${title}</h2>
      <p class="faint" style="margin-top:-.25rem">${blurb}</p>
      ${rows.map(renderAccountRow)}
    </section>
  `;
}

function renderAccountRow(row: AccountRow): SafeHtml {
  const { account, balances } = row;
  return html`
    <div class="row-between" style="padding:.6rem 0;border-top:1px solid var(--border)">
      <div>
        <a href="/accounts/${account.id}" style="font-weight:600">
          ${account.nickname || account.name}
        </a>
        ${when(account.last4, () => html`<span class="faint"> ····${account.last4}</span>`)}
        <div style="margin-top:.25rem;display:flex;gap:.4rem;flex-wrap:wrap">
          <span class="chip">${SUBTYPE_LABELS[account.subtype] ?? account.subtype}</span>
          ${when(row.holderName, () => html`<span class="chip">${row.holderName}</span>`)}
          ${renderStateChip(row)}
          ${when(row.funding && row.funding.unfunded > 0, () => html`
            <span class="chip chip-warning">
              ${formatPaise(row.funding!.unfunded)} unfunded
            </span>
          `)}
        </div>
      </div>
      <div style="text-align:right;display:flex;align-items:center;gap:.6rem">
        ${when((row.balanceSeries?.length ?? 0) >= 2, () => sparkline({
          points: row.balanceSeries!,
          title: `${account.nickname || account.name} recent balance`,
          color: balances.working < 0 ? "var(--danger)" : "var(--accent)",
        }))}
        <div>
          <strong class="amount ${balances.working < 0 ? "amount-negative" : ""}">
            <span aria-hidden="true">${formatPaise(balances.working)}</span>
            <span class="sr-only">${speakPaise(balances.working)}</span>
          </strong>
          ${when(balances.uncleared !== 0, () => html`
            <div class="faint">${formatPaise(balances.uncleared)} uncleared</div>
          `)}
        </div>
      </div>
    </div>
  `;
}

function renderStateChip(row: AccountRow): SafeHtml {
  // R7.c: a broken checkpoint says so until the account is reconciled again.
  if (row.checkpointBroken) {
    return html`<span class="chip chip-danger">
      reconciled ${row.lastReconciled ? formatDate(row.lastReconciled) : ""} — changed since
    </span>`;
  }
  if (row.lastReconciled) {
    const days = daysBetween(row.lastReconciled, todayIST());
    return html`<span class="chip chip-positive">
      reconciled ${days === 0 ? "today" : `${days} day${days === 1 ? "" : "s"} ago`}
    </span>`;
  }
  if (row.unclearedCount > 0) {
    return html`<span class="chip">${row.unclearedCount} uncleared</span>`;
  }
  return html`<span class="chip">never reconciled</span>`;
}

// ---------------------------------------------------------------------------
// S2a · Register, and S2b · the credit card panel
// ---------------------------------------------------------------------------

export interface RegisterRow {
  id: string;
  date: IsoDate;
  payee: string | null;
  category: string | null;
  memo: string | null;
  tags: string[];
  amount: Paise;
  cleared: boolean;
  isTransfer: boolean;
  cardLabel: string | null;
  ownerName: string | null;
  runningBalance: Paise;
}

export function renderAccountDetail(opts: {
  account: Account;
  /** H2 · Who this account could belong to. Empty for a one-person household. */
  members?: { id: string; name: string }[];
  /** 15 · The budgets this account could live in. */
  budgets?: { id: string; name: string; kind: string }[];
  balances: AccountBalances;
  rows: RegisterRow[];
  cards: Card[];
  funding: CardFunding | null;
  paymentCategoryName: string | null;
  lastStatement: { amount: Paise; date: IsoDate; due: IsoDate } | null;
  lastReconciled: IsoDate | null;
  checkpointBroken: boolean;
}): SafeHtml {
  const { account, balances, rows, cards, funding } = opts;

  return html`
    <div class="row-between" style="margin-bottom:1rem">
      <div>
        <h1 style="margin-bottom:.15rem">${account.nickname || account.name}</h1>
        <p class="faint" style="margin:0">
          ${SUBTYPE_LABELS[account.subtype] ?? account.subtype}
          ${when(account.last4, () => html` · ····${account.last4}`)}
        </p>
      </div>
      <div class="row">
        <a class="button" href="/accounts/${account.id}/reconcile">Reconcile</a>
        <a class="button button-primary" href="/add?account=${account.id}">Add transaction</a>
      </div>
    </div>

    ${when(opts.checkpointBroken, () => html`
      <p class="notice notice-warning">
        Something dated on or before the last reconciliation has changed since, so that
        checkpoint no longer holds. Reconcile again to re-assert the balance.
      </p>
    `)}

    ${when(account.closed_at, () => html`
      <p class="notice notice-info">
        This account is closed. Its history and balances are kept, and it no
        longer appears when you add a transaction.
      </p>
    `)}

    <div class="card">
      <div class="row" style="gap:2rem;flex-wrap:wrap">
        ${balanceFigure("Cleared", balances.cleared)}
        ${balanceFigure("Uncleared", balances.uncleared)}
        ${balanceFigure("Working", balances.working)}
      </div>
    </div>

    <!--
      B70 · F2.7 has said an account is "closeable without deletion" from the
      start, and closeAccount, reopenAccount and updateAccount were all written.
      None of them had a route, so in practice an account could be created and
      never renamed or closed — and over a decade every account the household
      has ever held stays in every dropdown for good.
    -->
    <details class="card">
      <summary class="linkish">Rename or close this account</summary>

      <form method="post" action="/accounts/${account.id}/edit" style="margin-top:.75rem">
        <div class="grid-2">
          <div class="field">
            <label for="acc-name">Name</label>
            <input id="acc-name" name="name" value="${account.name}" required>
          </div>
          <div class="field">
            <label for="acc-nickname">What you call it (optional)</label>
            <input id="acc-nickname" name="nickname" value="${account.nickname ?? ""}">
          </div>
        </div>
        <div class="grid-2">
          <div class="field">
            <label for="acc-institution">Institution</label>
            <input id="acc-institution" name="institution" value="${account.institution ?? ""}">
          </div>
          <div class="field">
            <label for="acc-last4">Last four digits</label>
            <input id="acc-last4" name="last4" inputmode="numeric" maxlength="4"
                   value="${account.last4 ?? ""}">
            <p class="field-hint">Used to match bank SMS and statements to this account.</p>
          </div>
        </div>
        ${when((opts.budgets ?? []).length > 1 && account.kind !== "tracking", () => html`
          <div class="field">
            <label for="acc-budget">Whose money it is</label>
            <select id="acc-budget" name="budget_id">
              ${(opts.budgets ?? []).map(
                (b) => html`
                  <option value="${b.id}" ${raw(account.budget_id === b.id ? "selected" : "")}>
                    ${b.kind === "household" ? "The household budget" : `${b.name}'s budget`}
                  </option>
                `,
              )}
            </select>
            <p class="field-hint">
              Moving it moves its balance to that budget's Ready to Assign, and its
              spending to that budget's envelopes.
            </p>
          </div>
        `)}
        ${when((opts.members ?? []).length > 1, () => html`<div class="grid-2">
          <div class="field">
            <label for="acc-holder">Whose account is it</label>
            <select id="acc-holder" name="holder_member_id">
              <option value="">The household's, jointly</option>
              ${(opts.members ?? []).map(
                (m) => html`
                  <option value="${m.id}" ${raw(account.holder_member_id === m.id ? "selected" : "")}>
                    ${m.name}
                  </option>
                `,
              )}
            </select>
            <p class="field-hint">
              A label only. Every account funds the one shared budget either way.
            </p>
          </div>
        </div>`)}
        <button type="submit">Save</button>
      </form>

      <form method="post" action="/accounts/${account.id}/${account.closed_at ? "reopen" : "close"}"
            style="margin-top:1rem;border-top:1px solid var(--border);padding-top:1rem">
        ${account.closed_at
          ? html`<button class="button-small" type="submit">Reopen this account</button>`
          : html`
              <p class="faint" style="margin-top:0">
                Closing keeps every transaction and every balance. It only takes
                the account out of the lists you pick from.
              </p>
              <button class="button-small button-danger" type="submit">Close this account</button>
            `}
      </form>
    </details>

    ${when(account.kind === "credit", () => renderCardPanel(opts))}
    ${when(cards.length > 1, () => renderCardBreakdown(cards, account.id))}

    <section class="card">
      <h2>Transactions</h2>
      ${rows.length === 0
        ? html`<p class="faint">Nothing recorded in this account yet.</p>`
        : html`
            <div class="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Date</th>
                    <th scope="col">Payee</th>
                    <th scope="col">Category</th>
                    <th scope="col" class="num">Amount</th>
                    <th scope="col" class="num">Balance</th>
                    <th scope="col">Cleared</th>
                  </tr>
                </thead>
                <tbody>
                  ${rows.map(
                    (r) => html`
                      <tr style="${r.cleared ? "" : "opacity:.75"}">
                        <td>${formatDate(r.date)}</td>
                        <td>
                          <a href="/transaction/${r.id}">${r.payee ?? (r.isTransfer ? "Transfer" : "—")}</a>
                          ${when(r.cardLabel, () => html`<div class="faint">${r.cardLabel}</div>`)}
                          ${when(r.memo, () => html`<div class="faint">${r.memo}</div>`)}
                        </td>
                        <td>
                          ${r.category ?? html`<span class="chip chip-warning">Uncategorised</span>`}
                          ${r.tags.map((t) => html`<span class="chip">#${t}</span>`)}
                        </td>
                        <td class="num amount ${r.amount < 0 ? "amount-negative" : "amount-positive"}">
                          ${formatPaise(r.amount)}
                        </td>
                        <td class="num amount">${formatPaise(r.runningBalance)}</td>
                        <td>${r.cleared ? "✓" : "—"}</td>
                      </tr>
                    `,
                  )}
                </tbody>
              </table>
            </div>
          `}
    </section>
  `;
}

function balanceFigure(label: string, amount: Paise): SafeHtml {
  return html`
    <div>
      <div class="faint">${label}</div>
      <strong class="amount ${amount < 0 ? "amount-negative" : ""}" style="font-size:1.15rem">
        ${formatPaise(amount)}
      </strong>
    </div>
  `;
}

/** S2b. The shortfall is stated in words, per 03 §7. */
function renderCardPanel(opts: {
  account: Account;
  funding: CardFunding | null;
  paymentCategoryName: string | null;
  lastStatement: { amount: Paise; date: IsoDate; due: IsoDate } | null;
}): SafeHtml {
  const { funding, account } = opts;
  if (!funding) return raw("");

  return html`
    <section class="card">
      <h2>This card</h2>
      <div class="row" style="gap:2rem;flex-wrap:wrap">
        ${balanceFigure("Outstanding", funding.outstanding)}
        ${balanceFigure("Funded", funding.funded)}
        ${balanceFigure("Unfunded", -funding.unfunded)}
      </div>

      ${funding.unfunded > 0
        ? html`<p class="notice notice-warning">
            <strong>${formatPaise(funding.unfunded)}</strong> of this balance isn't funded yet.
          </p>`
        : html`<p class="notice notice-success">
            This whole balance is funded — the cash to clear it is already set aside.
          </p>`}

      ${opts.lastStatement
        ? html`
            <p>
              Last statement <strong>${formatPaise(opts.lastStatement.amount)}</strong>
              on ${formatDate(opts.lastStatement.date)},
              due ${formatDate(opts.lastStatement.due)}.
              <a href="/accounts/${account.id}/statement">Record a new one</a>
            </p>
          `
        : html`
            <!-- R6/F2.3: statement cycles are not calendar months, so the app
                 cannot infer them — the statement is entered. -->
            <p class="faint">
              No statement recorded yet. Statement cycles don't follow calendar months,
              so funding advice keys off the statement rather than the month boundary.
              <a href="/accounts/${account.id}/statement">Record a statement</a>
            </p>
          `}

      <div class="row" style="flex-wrap:wrap">
        <a class="button" href="/transfer?to=${account.id}">Record a payment</a>
        ${when(funding.unfunded > 0, () => html`
          <a class="button button-primary" href="/move?amount=${funding.unfunded}">Fund the shortfall</a>
        `)}
        <a class="button" href="/accounts/${account.id}/cards">Manage cards</a>
      </div>
    </section>
  `;
}

/** R6.d: "what did the add-on spend this cycle" must be one filter. */
function renderCardBreakdown(cards: Card[], accountId: string): SafeHtml {
  return html`
    <section class="card">
      <h2>Cards on this account</h2>
      <p class="faint" style="margin-top:-.25rem">
        Add-on cards share this account's limit, statement and payment — but each
        transaction records which card it was made on.
      </p>
      ${cards.map(
        (card) => html`
          <div class="row-between" style="padding:.5rem 0;border-top:1px solid var(--border)">
            <div>
              <strong>${card.label}</strong>
              ${when(card.last4, () => html`<span class="faint"> ····${card.last4}</span>`)}
              ${when(card.is_primary === 1, () => html`<span class="chip chip-info">Primary</span>`)}
            </div>
            <a class="button button-small" href="/accounts/${accountId}?card=${card.id}">
              See its spending
            </a>
          </div>
        `,
      )}
    </section>
  `;
}

// ---------------------------------------------------------------------------
// New account form (F2)
// ---------------------------------------------------------------------------

export function renderNewAccountForm(opts: {
  error?: string | null;
  members?: { id: string; name: string }[];
  budgets?: { id: string; name: string; kind: string }[];
} = {}): SafeHtml {
  return html`
    <h1>Add an account</h1>
    ${when(opts.error, () => html`<p class="notice notice-error">${opts.error}</p>`)}

    <form method="post" action="/accounts/new" class="card">
      ${when((opts.budgets ?? []).length > 1, () => html`
        <div class="grid-2">
          <div class="field">
            <label for="new-budget">Whose money it is</label>
            <select id="new-budget" name="budget_id">
              ${(opts.budgets ?? []).map(
                (b) => html`
                  <option value="${b.id}">
                    ${b.kind === "household" ? "The household budget" : `${b.name}'s budget`}
                  </option>
                `,
              )}
            </select>
          </div>
          <div class="field">
            <label for="new-visibility">Who can see it</label>
            <select id="new-visibility" name="visibility">
              <option value="household">Shared with the household</option>
              <option value="private">Private to me</option>
            </select>
            <p class="field-hint">
              Private needs it to be in your own budget — the household's Ready to
              Assign would otherwise give the balance away.
            </p>
          </div>
        </div>
      `)}
      <div class="field">
        <label for="name">Name</label>
        <input id="name" name="name" required autocomplete="off" placeholder="HDFC Savings">
      </div>

      <fieldset>
        <legend>What kind of account is this?</legend>
        <div class="field">
          <label for="kind">Kind</label>
          <select id="kind" name="kind" required>
            <option value="budget">Budget — its balance funds your envelopes</option>
            <option value="credit">Credit — spending creates a liability</option>
            <option value="tracking">Tracking — a balance only, never funds the budget</option>
          </select>
        </div>
        <div class="field">
          <label for="subtype">Type</label>
          <select id="subtype" name="subtype" required>
            ${Object.entries(ACCOUNT_SUBTYPES).flatMap(([kind, subtypes]) =>
              subtypes
                // B56: a family loan or a loan carries a companion record, so it
                // is created on its own screen, not here — offering it here made
                // an orphan that never showed on Lending or Loans.
                .filter((s) => !(s in MANAGED_SUBTYPES))
                .map(
                  (s) => html`<option value="${s}" data-kind="${kind}">${SUBTYPE_LABELS[s] ?? s}</option>`,
                ),
            )}
          </select>
        </div>
        <p class="field-hint">
          Lending to family? Use <a href="/family">the Lending page</a>.
          A loan or EMI? Use <a href="/loans">the Loans page</a>. Investments go
          through <a href="/portfolio">Portfolio</a>. Each sets up more than a bare
          balance, which is why they live on their own screen.
        </p>
      </fieldset>

      <div class="grid-2">
        <div class="field">
          <label for="opening_balance">Current balance</label>
          <input id="opening_balance" name="opening_balance" class="amount-input"
                 type="text" inputmode="decimal" placeholder="0.00">
          <p class="field-hint">
            For a credit card, enter what you currently owe — it will be recorded as a
            negative balance, and shown as debt rather than as a budgeting error.
          </p>
        </div>
        <div class="field">
          <label for="opening_date">As of</label>
          <input id="opening_date" name="opening_date" type="text"
                 placeholder="DD-MM-YYYY" autocomplete="off">
          <p class="field-hint">Defaults to today. DD-MM also works.</p>
        </div>
      </div>

      <div class="grid-2">
        <div class="field">
          <label for="last4">Last four digits <span class="faint">(optional)</span></label>
          <input id="last4" name="last4" inputmode="numeric" maxlength="4" autocomplete="off">
          <p class="field-hint">Used to match bank alerts to the right account.</p>
        </div>
        <div class="field">
          <label for="institution">Bank <span class="faint">(optional)</span></label>
          <input id="institution" name="institution" autocomplete="off" placeholder="HDFC Bank">
        </div>
      </div>

      <fieldset>
        <legend>Credit cards only</legend>
        <div class="grid-2">
          <div class="field">
            <label for="statement_day">Statement day</label>
            <input id="statement_day" name="statement_day" type="number" min="1" max="31">
          </div>
          <div class="field">
            <label for="due_day">Payment due day</label>
            <input id="due_day" name="due_day" type="number" min="1" max="31">
          </div>
        </div>
        <p class="field-hint">
          Statement cycles rarely line up with calendar months, so these are recorded
          separately from the budget month.
        </p>
      </fieldset>

      <button class="button-primary" type="submit">Add account</button>
    </form>
  `;
}

/**
 * B51 · Manage the cards on an account (F2.9), including add-on cards.
 *
 * `createCard`/`listCards`/`closeCard` all existed, but the "Manage cards"
 * button linked to `/accounts/:id/cards`, which had no route. This is the page:
 * the cards on the account, and a form to add an add-on card held by another
 * member — the mechanic Q-decisions made first-class.
 */
/**
 * F2.3 · Record a credit-card statement. The billing cycle is not the calendar
 * month, so the statement date, due date and statemented balance are entered
 * from the statement — funding advice then keys off the due date.
 */
export function renderCardStatementForm(opts: {
  account: Account;
  last: CardStatement | null;
  today: IsoDate;
}): SafeHtml {
  return html`
    <div class="row-between" style="margin-bottom:1rem">
      <h1>Statement — ${opts.account.nickname || opts.account.name}</h1>
      <a class="button button-quiet" href="/accounts/${opts.account.id}">Back to account</a>
    </div>
    ${when(opts.last, () => html`
      <p class="faint">
        Last recorded: ${formatPaise(opts.last!.amount)} on
        ${formatDate(opts.last!.statement_date)}, due ${formatDate(opts.last!.due_date)}.
      </p>
    `)}
    <form method="post" action="/accounts/${opts.account.id}/statement" class="card">
      <div class="grid-2">
        <div class="field">
          <label for="amount">Statement balance</label>
          <input id="amount" name="amount" class="amount-input" type="text"
                 inputmode="decimal" autocomplete="off" required autofocus placeholder="0.00">
          <p class="field-hint">The total shown on the statement — what is owed, not the minimum.</p>
        </div>
        <div class="field">
          <label for="minimum_due">Minimum due <span class="faint">(optional)</span></label>
          <input id="minimum_due" name="minimum_due" class="amount-input" type="text"
                 inputmode="decimal" autocomplete="off" placeholder="0.00">
        </div>
      </div>
      <div class="grid-2">
        <div class="field">
          <label for="statement_date">Statement date</label>
          <input id="statement_date" name="statement_date" type="text" autocomplete="off"
                 value="${formatDate(opts.today)}" placeholder="DD-MM-YYYY">
        </div>
        <div class="field">
          <label for="due_date">Due date</label>
          <input id="due_date" name="due_date" type="text" autocomplete="off"
                 required placeholder="DD-MM-YYYY">
        </div>
      </div>
      <button class="button-primary" type="submit">Record statement</button>
      <a class="button button-quiet" href="/accounts/${opts.account.id}">Cancel</a>
    </form>
  `;
}

export function renderManageCards(opts: {
  account: Account;
  cards: Card[];
  members: { id: string; name: string }[];
  error?: string | null;
}): SafeHtml {
  const memberName = (id: string | null) =>
    id ? (opts.members.find((m) => m.id === id)?.name ?? "someone") : null;

  return html`
    <div class="row-between" style="margin-bottom:1rem">
      <h1>Cards on ${opts.account.nickname || opts.account.name}</h1>
      <a class="button button-quiet" href="/accounts/${opts.account.id}">Back to account</a>
    </div>
    ${when(opts.error, () => html`<p class="notice notice-error">${opts.error}</p>`)}

    <section class="card">
      <h2>Cards</h2>
      ${opts.cards.length === 0
        ? html`<p class="faint">No cards recorded yet.</p>`
        : opts.cards.map(
            (c) => html`
              <div class="row-between" style="padding:.5rem 0;border-top:1px solid var(--border)">
                <div>
                  <strong>${c.label}</strong>
                  ${when(c.last4, () => html`<span class="faint"> · ending ${c.last4}</span>`)}
                  ${c.is_primary
                    ? html`<span class="chip">primary</span>`
                    : html`<span class="chip">add-on</span>`}
                  ${when(memberName(c.holder_member_id), () => html`
                    <div class="faint">held by ${memberName(c.holder_member_id)}</div>
                  `)}
                </div>
                ${when(!c.is_primary, () => html`
                  <form method="post" action="/accounts/${opts.account.id}/cards/${c.id}/close">
                    <button class="button-small" type="submit">Close</button>
                  </form>
                `)}
              </div>
            `,
          )}
    </section>

    <section class="card">
      <h2>Add an add-on card</h2>
      <p class="faint" style="margin-top:-.25rem">
        A card on this account held by another member — it shares this account's limit,
        statement and single payment. Spending on it defaults to its holder (R6.e).
      </p>
      <form method="post" action="/accounts/${opts.account.id}/cards">
        <div class="grid-2">
          <div class="field">
            <label for="label">Label</label>
            <input id="label" name="label" autocomplete="off" required
                   placeholder="Axis Atlas — Priya">
          </div>
          <div class="field">
            <label for="last4">Last four digits</label>
            <input id="last4" name="last4" inputmode="numeric" autocomplete="off"
                   maxlength="4" placeholder="1234">
          </div>
        </div>
        <div class="field">
          <label for="holder_member_id">Held by</label>
          <select id="holder_member_id" name="holder_member_id">
            <option value="">Not set</option>
            ${opts.members.map((m) => html`<option value="${m.id}">${m.name}</option>`)}
          </select>
        </div>
        <button class="button-primary" type="submit">Add card</button>
      </form>
    </section>
  `;
}
