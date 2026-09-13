/**
 * S2c · The reconcile flow.
 *
 * Enter the bank's balance and date → the difference → the uncleared items with
 * checkboxes → either it balances (confirm, lock the checkpoint) or an
 * adjustment is offered (F9.2).
 */

import { html, raw, when, type SafeHtml } from "../../http/html.ts";
import { formatPaise } from "../../core/money.ts";
import { formatDate, type IsoDate } from "../../core/dates.ts";
import type { Account } from "../../domain/accounts.ts";
import type {
  ReconciliationPreview, Checkpoint, ReconciliationStatus,
} from "../../domain/reconciliation.ts";

export function renderReconcileStart(opts: {
  account: Account;
  status: ReconciliationStatus;
  checkpoints: Checkpoint[];
  today: IsoDate;
  clearedBalance: number;
  error?: string | null;
}): SafeHtml {
  const { account, status } = opts;

  return html`
    <h1>Reconcile ${account.nickname || account.name}</h1>
    ${when(opts.error, () => html`<p class="notice notice-error">${opts.error}</p>`)}

    ${when(status.broken, () => html`
      <p class="notice notice-warning">
        Reconciled ${status.lastReconciled ? formatDate(status.lastReconciled) : ""} — changed since.
        ${status.brokenReason ?? ""} Reconciling again is what re-asserts the balance.
      </p>
    `)}

    <form method="post" action="/accounts/${account.id}/reconcile" class="card">
      <p class="muted">
        The app currently shows <strong>${formatPaise(opts.clearedBalance)}</strong> cleared
        in this account.
      </p>

      <div class="grid-2">
        <div class="field">
          <label for="bank_balance">What does the bank say?</label>
          <input id="bank_balance" name="bank_balance" class="amount-input"
                 type="text" inputmode="decimal" required autofocus placeholder="0.00">
        </div>
        <div class="field">
          <label for="as_of">As of</label>
          <input id="as_of" name="as_of" type="date" autocomplete="off"
                 value="${opts.today}">
        </div>
      </div>

      <button class="button-primary" type="submit">Check it</button>
      <a class="button button-quiet" href="/accounts/${account.id}">Cancel</a>
    </form>

    ${when(opts.checkpoints.length > 0, () => html`
      <section class="card">
        <h2>Previous reconciliations</h2>
        ${opts.checkpoints.map(
          (c) => html`
            <div class="row-between" style="padding:.5rem 0;border-top:1px solid var(--border)">
              <div>
                <strong>${formatDate(c.as_of)}</strong>
                <div class="faint">${formatPaise(c.bank_balance)}</div>
              </div>
              ${c.broken_at
                ? html`<span class="chip chip-danger">changed since</span>`
                : html`<span class="chip chip-positive">holds</span>`}
            </div>
          `,
        )}
      </section>
    `)}
  `;
}

/** The mismatch step: F9.2's three options, stated plainly. */
export function renderReconcileDifference(opts: {
  account: Account;
  preview: ReconciliationPreview;
}): SafeHtml {
  const { account, preview } = opts;
  const shortBy = preview.difference;

  return html`
    <h1>Reconcile ${account.nickname || account.name}</h1>

    <div class="card">
      <div class="row" style="gap:2rem;flex-wrap:wrap">
        <div>
          <div class="faint">The bank says</div>
          <strong class="amount" style="font-size:1.15rem">${formatPaise(preview.bankBalance)}</strong>
        </div>
        <div>
          <div class="faint">This app says</div>
          <strong class="amount" style="font-size:1.15rem">${formatPaise(preview.clearedBalance)}</strong>
        </div>
        <div>
          <div class="faint">Difference</div>
          <strong class="amount amount-negative" style="font-size:1.15rem">
            ${formatPaise(shortBy)}
          </strong>
        </div>
      </div>

      <p class="notice notice-warning">
        ${preview.uncleared.length > 0
          ? html`There are ${preview.uncleared.length} transactions the app doesn't think have
                 cleared yet. Ticking the ones that have will usually close the gap.`
          : html`Nothing is waiting to clear, so this is a genuine gap — something is missing
                 from the app, or was recorded differently.`}
      </p>
    </div>

    <form method="post" action="/accounts/${account.id}/reconcile" class="card">
      <input type="hidden" name="bank_balance" value="${(preview.bankBalance / 100).toFixed(2)}">
      <input type="hidden" name="as_of" value="${preview.asOf}">

      ${when(preview.uncleared.length > 0, () => html`
        <fieldset>
          <legend>Which of these have actually cleared?</legend>
          ${preview.uncleared.map(
            (t) => html`
              <label style="display:flex;gap:.6rem;align-items:center;min-height:44px;font-weight:400">
                <input type="checkbox" name="clear" value="${t.id}">
                <span style="flex:1">
                  ${t.payee ?? "Unknown payee"}
                  <span class="faint">· ${formatDate(t.date)}</span>
                  ${when(t.memo, () => html`<span class="faint"> · ${t.memo}</span>`)}
                </span>
                <span class="amount ${t.amount < 0 ? "amount-negative" : ""}">
                  ${formatPaise(t.amount)}
                </span>
              </label>
            `,
          )}
        </fieldset>
      `)}

      <button class="button-primary" type="submit">Check again</button>

      <hr style="border:none;border-top:1px solid var(--border);margin:1rem 0">

      <p class="muted">
        If the gap is real, record it as an adjustment. It goes into a
        Reconciliation category so it stays visible rather than quietly
        changing your balance.
      </p>
      <button class="button-danger" type="submit" name="allow_adjustment" value="1">
        Add a ${formatPaise(shortBy)} adjustment and reconcile
      </button>
      <a class="button button-quiet" href="/accounts/${account.id}">Cancel</a>
    </form>
  `;
}

/**
 * R7.b · The confirmation an edit to reconciled history needs, naming the
 * checkpoint and its date rather than asking a generic "are you sure".
 */
export function renderCheckpointConfirmation(opts: {
  accountName: string;
  checkpoints: Checkpoint[];
  action: string;
  hiddenFields: Record<string, string>;
  cancelHref: string;
}): SafeHtml {
  return html`
    <h1>This was already reconciled</h1>

    <div class="card">
      <p>
        ${opts.accountName} was reconciled on
        ${opts.checkpoints.map(
          (c) => html`<strong>${formatDate(c.as_of)}</strong> at ${formatPaise(c.bank_balance)}`,
        )}.
        Changing something dated on or before that means the balance you confirmed
        no longer holds.
      </p>
      <p class="muted">
        The change is allowed — history is never frozen. But that reconciliation
        will be marked as changed since, and will stay that way until you
        reconcile the account again. It won't be quietly repaired.
      </p>

      <form method="post" action="${opts.action}">
        ${Object.entries(opts.hiddenFields).map(
          ([name, value]) => html`<input type="hidden" name="${name}" value="${value}">`,
        )}
        <input type="hidden" name="confirm_checkpoint" value="1">
        <button class="button-danger" type="submit">Make the change anyway</button>
        <a class="button button-quiet" href="${opts.cancelHref}">Leave it alone</a>
      </form>
    </div>
  `;
}

export function renderReconcileDone(opts: {
  account: Account;
  checkpoint: Checkpoint;
  adjustment: number;
}): SafeHtml {
  return html`
    <div class="card empty-state">
      <div class="empty-icon" aria-hidden="true">✓</div>
      <h2>Reconciled</h2>
      <p>
        ${opts.account.nickname || opts.account.name} matched
        ${formatPaise(opts.checkpoint.bank_balance)} as of
        ${formatDate(opts.checkpoint.as_of)}.
        ${when(opts.adjustment !== 0, () => html`
          A ${formatPaise(opts.adjustment)} adjustment was recorded.
        `)}
      </p>
      <p>
        <a class="button" href="/accounts/${opts.account.id}">Back to the account</a>
        ${raw("")}
      </p>
    </div>
  `;
}
