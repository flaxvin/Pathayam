/**
 * S4 · Review — the single destination for everything that needs a human, and
 * S10 · Import.
 *
 * 03 §3: "Everything corrective lives in one place. One badge, one destination."
 * Sections appear in the priority order given there.
 */

import { html, raw, when, type SafeHtml } from "../../http/html.ts";
import { formatPaise, type Paise } from "../../core/money.ts";
import { formatDate, type IsoDate } from "../../core/dates.ts";
import type { StagedRow, ImportBatch } from "../../import/pipeline.ts";
import { prominenceOf, type DuplicateTier } from "../../import/dedupe.ts";
import type { CategoryView } from "../viewmodel.ts";
import type { Account } from "../../domain/accounts.ts";
import { renderProposals, type ProposedRule } from "./manage.ts";

export interface ReviewData {
  staged: StagedRow[];
  uncategorised: {
    id: string; date: IsoDate; amount: Paise; payee: string | null; account: string;
    /** B93 · Where this payee's money usually goes, if it has been seen before. */
    usual_category_id?: string | null;
  }[];
  /** B93 · How many are waiting in total, when more than one page of them is. */
  uncategorisedTotal?: number;
  overspent: CategoryView[];
  unfundedCards: { accountId: string; name: string; unfunded: Paise; categoryId: string }[];
  brokenCheckpoints: { accountId: string; name: string; asOf: IsoDate; reason: string | null }[];
  proposedRules: ProposedRule[];
  categories: CategoryView[];
  /** B84 · Money fronted and not yet back. */
  claims: { id: string; date: IsoDate; amount: Paise; payee: string | null; category: string | null }[];
  bufferReading: string;
  month: string;
}

export function renderReview(data: ReviewData): SafeHtml {
  const total =
    data.staged.length + data.uncategorised.length + data.overspent.length +
    data.unfundedCards.length + data.brokenCheckpoints.length + data.proposedRules.length;
  // Outstanding claims are shown but never counted: being owed money is a
  // standing fact, not a task waiting on a decision, and a badge that never
  // reaches zero stops meaning anything.

  if (total === 0) {
    // 03 §7: zero states are achievements, not emptiness.
    return html`
      <div class="card empty-state">
        <div class="empty-icon" aria-hidden="true">✓</div>
        <h2>Nothing to review</h2>
        <p>${data.bufferReading}</p>
        <p><a class="button" href="/">Back to the budget</a></p>
      </div>
    `;
  }

  return html`
    <h1>Review <span class="chip chip-warning">${total}</span></h1>

    ${when(data.staged.length > 0, () => renderStaged(data))}
    ${when(data.uncategorised.length > 0, () => renderUncategorised(data))}
    ${when(data.claims.length > 0, () => renderClaims(data))}
    ${when(data.overspent.length > 0, () => renderOverspent(data))}
    ${when(data.unfundedCards.length > 0, () => renderUnfundedCards(data))}
    ${when(data.brokenCheckpoints.length > 0, () => renderBrokenCheckpoints(data))}
    ${when(data.proposedRules.length > 0, () => renderProposedRules(data))}
  `;
}

function renderStaged(data: ReviewData): SafeHtml {
  /*
   * S4 §2 · Not every suspected pair deserves the same alarm. A strong match —
   * same amount, same day, same reference — is almost certainly one purchase
   * arriving twice. A weak one is two people at the same restaurant, which `04`
   * §4 calls normal and D2 says must be easy to keep.
   *
   * `prominenceOf` has encoded that since the module was written and nothing
   * asked it, so every pair shouted equally: a weak coincidence carried the same
   * warning as a certain duplicate, which is how a queue teaches people to
   * dismiss it without reading. Strong matches lead, weak ones follow and say so.
   */
  const duplicates = data.staged
    .filter((r) => r.duplicate_of_id !== null)
    .sort((a, b) => rank(a) - rank(b));
  const weak = duplicates.filter((r) => prominence(r) === "low").length;
  const plain = data.staged.filter((r) => r.duplicate_of_id === null);

  return html`
    ${when(plain.length > 0, () => html`
      <section class="card">
        <h2>Imported, needs confirmation <span class="chip">${plain.length}</span></h2>
        ${plain.map((row) => renderStagedRow(row, data.categories))}
      </section>
    `)}

    ${when(duplicates.length > 0, () => html`
      <section class="card">
        <h2>Suspected duplicates <span class="chip chip-warning">${duplicates.length}</span></h2>
        <p class="faint" style="margin-top:-.25rem">
          Two people paying for two things at the same restaurant is normal —
          keeping both is one tap.${weak > 0
            ? ` ${weak} of these ${weak === 1 ? "is a weak match" : "are weak matches"}, ` +
              `shown last.`
            : ""}
        </p>
        ${duplicates.map((row) => renderDuplicateRow(row, data.categories, prominence(row)))}
      </section>
    `)}
  `;
}

function renderStagedRow(row: StagedRow, categories: CategoryView[]): SafeHtml {
  return html`
    <form method="post" action="/review/approve"
          style="padding:.75rem 0;border-top:1px solid var(--border)">
      <input type="hidden" name="staged_id" value="${row.id}">

      <div class="row-between" style="align-items:flex-start">
        <div style="flex:1;min-width:0">
          <strong>${row.proposed_payee ?? "Unknown payee"}</strong>
          <span class="faint"> · ${formatDate(row.date)}</span>
          <!-- P4: the raw string is always visible, never replaced. -->
          <div class="faint" style="word-break:break-all">${row.raw_narration}</div>
          ${when(row.applied_rules_json, () => html`
            <span class="chip chip-info">set by a rule</span>
          `)}
        </div>
        <strong class="amount ${row.amount < 0 ? "amount-negative" : "amount-positive"}">
          ${formatPaise(row.amount)}
        </strong>
      </div>

      <div class="row" style="margin-top:.5rem;flex-wrap:wrap">
        <label class="sr-only" for="cat-${row.id}">Category</label>
        <!--
          B99 · Money out names its envelope before it enters the ledger. Money
          in does not: it lands in Ready to Assign, which is the model, so the
          requirement follows the sign rather than being asked of everything.
        -->
        <select id="cat-${row.id}" name="category_id" style="flex:1;min-width:12rem"
                ${raw(row.amount < 0 ? "required" : "")}>
          <!--
            Money in with an envelope is a refund: it goes back where it was
            spent. Money in without one is new money for Ready to Assign. Both
            are right, and the difference is the whole model — so the list says
            which is which rather than offering every envelope unlabelled
            under "No category needed", where picking one looks like tidiness
            and quietly reads as un-spending.
          -->
          <option value="">
            ${row.amount < 0 ? "Choose where it came from…" : "Ready to Assign — new money"}
          </option>
          ${when(row.amount >= 0, () => html`
            <optgroup label="Or put it back — a refund into…">
              ${categories
                .filter((c) => !c.isPaymentCategory && !c.commitsToBudgetId && !c.hidden)
                .map((c) => html`
                  <option value="${c.id}" ${raw(c.id === row.category_id ? "selected" : "")}>
                    ${c.name}
                  </option>
                `)}
            </optgroup>
          `)}
          ${when(row.amount < 0, () => html`
            ${categories
              .filter((c) => !c.isPaymentCategory && !c.commitsToBudgetId && !c.hidden)
              .map((c) => html`
                <option value="${c.id}" ${raw(c.id === row.category_id ? "selected" : "")}>
                  ${c.name}
                </option>
              `)}
          `)}
        </select>
        <button class="button-primary button-small" type="submit">Approve</button>
        <button class="button-small" type="submit" formaction="/review/reject">Dismiss</button>
      </div>
    </form>
  `;
}

/** How loudly this pair should be put to the reader (S4 §2). */
function prominence(row: StagedRow): "high" | "low" {
  return row.duplicate_tier ? prominenceOf(row.duplicate_tier as DuplicateTier) : "high";
}

/** High first, so the pairs most likely to be real duplicates lead the queue. */
function rank(row: StagedRow): number {
  return prominence(row) === "high" ? 0 : 1;
}

/** S4 §2: pairs side by side, with the match reason stated. */
function renderDuplicateRow(
  row: StagedRow, categories: CategoryView[], loudness: "high" | "low" = "high",
): SafeHtml {
  return html`
    <form method="post" action="/review/merge"
          style="padding:.75rem 0;border-top:1px solid var(--border)">
      <input type="hidden" name="staged_id" value="${row.id}">

      ${loudness === "high"
        ? html`<p class="notice notice-warning" style="margin-bottom:.5rem">${row.duplicate_reason}</p>`
        : html`
            <p class="faint" style="margin-bottom:.5rem">
              <span class="chip">Weak match</span> ${row.duplicate_reason}
            </p>
          `}

      <div class="row-between">
        <div>
          <strong>${row.proposed_payee ?? "Unknown payee"}</strong>
          <span class="faint"> · ${formatDate(row.date)}</span>
          <div class="faint" style="word-break:break-all">${row.raw_narration}</div>
        </div>
        <strong class="amount">${formatPaise(row.amount)}</strong>
      </div>

      <div class="row" style="margin-top:.5rem;flex-wrap:wrap">
        <button class="button-primary button-small" type="submit">
          Merge — keep one transaction
        </button>
        <button class="button-small" type="submit" formaction="/review/approve">
          Keep both
        </button>
        <button class="button-small" type="submit" formaction="/review/reject">
          Discard the imported one
        </button>
      </div>
      <input type="hidden" name="category_id" value="${row.category_id ?? ""}">
      ${when(categories.length === 0, () => raw(""))}
    </form>
  `;
}

/** B93 · The category this payee's money usually goes to, resolved to a name. */
function usualOf(
  data: ReviewData,
  row: ReviewData["uncategorised"][number],
): { id: string; name: string } | null {
  if (!row.usual_category_id) return null;
  const category = data.categories.find(
    (c) => c.id === row.usual_category_id && !c.isPaymentCategory && !c.commitsToBudgetId && !c.hidden,
  );
  return category ? { id: category.id, name: category.name } : null;
}

function renderUncategorised(data: ReviewData): SafeHtml {
  return html`
    <section class="card">
      <h2>Uncategorised <span class="chip">${data.uncategorisedTotal ?? data.uncategorised.length}</span></h2>
      <p class="faint" style="margin-top:-.25rem">
        These are in the ledger and already affect your balances, but no envelope
        has recorded them.
        ${when((data.uncategorisedTotal ?? 0) > data.uncategorised.length, () => html`
          Showing the ${data.uncategorised.length} most recent — file these and the next lot appears.
        `)}
      </p>
      ${data.uncategorised.map(
        (t) => html`
          <div style="padding:.6rem 0;border-top:1px solid var(--border)">
            <div class="row-between">
              <div>
                <a href="/transaction/${t.id}">${t.payee ?? "Unknown payee"}</a>
                <div class="faint">${formatDate(t.date)} · ${t.account}</div>
              </div>
              <strong class="amount ${t.amount < 0 ? "amount-negative" : ""}">
                ${formatPaise(t.amount)}
              </strong>
            </div>
            <!--
              B85 · The same control a staged import gets. Filing one of these
              used to mean opening the transaction and working a full edit form.

              B93 · And where the payee has been seen before, the usual category
              is offered as a single button. Most of this queue is the same
              handful of merchants over and over, so the common case should not
              cost a trip through a nineteen-option list — and rendering that
              list once per row was 69% of the page.
            -->
            ${when(usualOf(data, t), () => html`
              <form method="post" action="/transaction/${t.id}/categorise"
                    class="row" style="gap:.4rem;margin-top:.4rem">
                <input type="hidden" name="return_to" value="/review">
                <input type="hidden" name="category_id" value="${usualOf(data, t)!.id}">
                <button class="button-small button-primary" type="submit">
                  File as ${usualOf(data, t)!.name}
                </button>
                <span class="faint">where ${t.payee ?? "this payee"} usually goes</span>
              </form>
            `)}
            <details style="margin-top:.4rem">
              <summary class="linkish">${usualOf(data, t) ? "Somewhere else" : "Choose a category"}</summary>
              <form method="post" action="/transaction/${t.id}/categorise"
                    class="row" style="gap:.4rem;margin-top:.4rem;flex-wrap:wrap">
                <input type="hidden" name="return_to" value="/review">
                <label class="sr-only" for="cat-${t.id}">Category for ${t.payee ?? "this transaction"}</label>
                <select id="cat-${t.id}" name="category_id" style="max-width:16rem">
                  <option value="">Leave uncategorised</option>
                  ${data.categories
                    .filter((c) => !c.isPaymentCategory && !c.commitsToBudgetId && !c.hidden)
                    .map((c) => html`
                      <option value="${c.id}">${c.name} — ${formatPaise(c.state.balance)} left</option>
                    `)}
                </select>
                <button class="button-small" type="submit">File it</button>
              </form>
            </details>
          </div>
        `,
      )}
    </section>
  `;
}

/**
 * B84 · Money the household has fronted.
 *
 * It has genuinely left the envelope, so it is not netted off anywhere — this
 * is a list, not an adjustment. The point is only that nobody forgets to chase
 * it, which is exactly what happened while the column existed and no screen
 * read it.
 */
function renderClaims(data: ReviewData): SafeHtml {
  const total = data.claims.reduce((sum, c) => sum + c.amount, 0) as Paise;
  return html`
    <section class="card">
      <h2>You're owed <span class="chip">${formatPaise(total)}</span></h2>
      <p class="faint" style="margin-top:-.25rem">
        Already spent from its envelope. Mark it settled when the money is back —
        record the repayment itself as ordinary income.
      </p>
      ${data.claims.map(
        (c) => html`
          <div class="row-between" style="padding:.5rem 0;border-top:1px solid var(--border)">
            <div>
              <a href="/transaction/${c.id}">${c.payee ?? "Unknown payee"}</a>
              <div class="faint">
                ${formatDate(c.date)}${when(c.category, () => html` · ${c.category}`)}
              </div>
            </div>
            <span class="row" style="gap:.6rem;align-items:center">
              <strong class="amount">${formatPaise(c.amount)}</strong>
              <form method="post" action="/transaction/${c.id}/settled">
                <button class="button-small" type="submit">Settled</button>
              </form>
            </span>
          </div>
        `,
      )}
    </section>
  `;
}

function renderOverspent(data: ReviewData): SafeHtml {
  return html`
    <section class="card">
      <h2>Overspent categories <span class="chip chip-danger">${data.overspent.length}</span></h2>
      ${data.overspent.map(
        (c) => html`
          <div class="row-between" style="padding:.5rem 0;border-top:1px solid var(--border)">
            <div>
              <strong>${c.name}</strong>
              <div class="faint">
                ${c.needsCover
                  ? `Over by ${formatPaise(-c.state.balance)} — cover it from another category?`
                  : `Over by ${formatPaise(-c.state.balance)} on a card. No cash was spent, so this is card debt to fund rather than money to move.`}
              </div>
            </div>
            ${when(c.needsCover, () => html`
              <a class="button button-small"
                 href="/move?to=${c.id}&amount=${(-c.state.balance / 100).toFixed(2)}&month=${data.month}">Cover</a>
            `)}
          </div>
        `,
      )}
    </section>
  `;
}

function renderUnfundedCards(data: ReviewData): SafeHtml {
  return html`
    <section class="card">
      <h2>Unfunded card balances <span class="chip chip-warning">${data.unfundedCards.length}</span></h2>
      ${data.unfundedCards.map(
        (card) => html`
          <div class="row-between" style="padding:.5rem 0;border-top:1px solid var(--border)">
            <div>
              <strong>${card.name}</strong>
              <div class="faint">
                ${formatPaise(card.unfunded)} of this balance isn't funded yet.
              </div>
            </div>
            <a class="button button-small"
               href="/move?to=${card.categoryId}&amount=${(card.unfunded / 100).toFixed(2)}&month=${data.month}">Fund it</a>
          </div>
        `,
      )}
    </section>
  `;
}

/** R7.d: broken checkpoints appear here until resolved. */
function renderBrokenCheckpoints(data: ReviewData): SafeHtml {
  return html`
    <section class="card">
      <h2>Reconciliations that no longer hold
        <span class="chip chip-danger">${data.brokenCheckpoints.length}</span></h2>
      ${data.brokenCheckpoints.map(
        (c) => html`
          <div class="row-between" style="padding:.5rem 0;border-top:1px solid var(--border)">
            <div>
              <strong>${c.name}</strong>
              <div class="faint">
                Reconciled ${formatDate(c.asOf)} — changed since.
                ${c.reason ?? ""}
              </div>
            </div>
            <a class="button button-small" href="/accounts/${c.accountId}/reconcile">Reconcile again</a>
          </div>
        `,
      )}
    </section>
  `;
}

function renderProposedRules(data: ReviewData): SafeHtml {
  return html`
    <section class="card">
      <h2>Proposed rules <span class="chip">${data.proposedRules.length}</span></h2>
      <p class="faint" style="margin-top:-.25rem">
        Learned from how you've been categorising. Nothing is applied until you confirm.
      </p>
      ${renderProposals(data.proposedRules)}
    </section>
  `;
}

// ---------------------------------------------------------------------------
// S10 · Import
// ---------------------------------------------------------------------------

export interface MappingPrompt {
  accountId: string;
  fileName: string;
  csv: string;
  /** The rows exactly as parsed — 04 §3.2 keeps them visible throughout. */
  rows: string[][];
  candidateHeaders: { index: number; cells: string[] }[];
  headerRow: number;
  choices: { index: number; label: string; sample: string }[];
  error?: string | null;
}

/**
 * `04` §3.2 · The mapping UI.
 *
 * "The mapping UI shows the raw rows throughout; an unrecognised file is a
 * mapping task, not an error." So this screen never says something went
 * wrong — it shows what arrived and asks which column is which.
 */
export function renderMapping(opts: MappingPrompt): SafeHtml {
  const column = (name: string, label: string, hint: string, required = false) => html`
    <div class="field">
      <label for="${name}">${label}</label>
      <select id="${name}" name="${name}" ${raw(required ? "required" : "")}>
        ${raw(required ? "" : '<option value="-1">Not in this file</option>')}
        ${opts.choices.map(
          (c) => html`
            <option value="${c.index}">
              ${c.label}${c.sample ? ` — e.g. ${c.sample}` : ""}
            </option>
          `,
        )}
      </select>
      <p class="field-hint">${hint}</p>
    </div>
  `;

  return html`
    <h1>Which column is which?</h1>
    <p class="muted">
      This file doesn't match anything seen before, so it needs setting up once.
      After that, every statement from this bank imports without asking.
    </p>
    ${when(opts.error, () => html`<p class="notice notice-error">${opts.error}</p>`)}

    <section class="card">
      <h2>What arrived</h2>
      <div class="table-scroll">
        <table>
          <tbody>
            ${opts.rows.slice(0, 8).map(
              (row, index) => html`
                <tr style="${index === opts.headerRow ? "background:var(--accent-soft)" : ""}">
                  <td class="faint">${index}</td>
                  ${row.map((cell) => html`<td>${cell}</td>`)}
                </tr>
              `,
            )}
          </tbody>
        </table>
      </div>
    </section>

    <form method="post" action="/import/map" class="card">
      <input type="hidden" name="account_id" value="${opts.accountId}">
      <input type="hidden" name="file_name" value="${opts.fileName}">
      <textarea name="csv" hidden>${opts.csv}</textarea>

      <div class="field">
        <label for="header_row">Which row holds the column names?</label>
        <select id="header_row" name="header_row">
          ${opts.candidateHeaders.map(
            (c) => html`
              <option value="${c.index}" ${raw(c.index === opts.headerRow ? "selected" : "")}>
                Row ${c.index}: ${c.cells.slice(0, 5).join(" · ")}
              </option>
            `,
          )}
        </select>
        <p class="field-hint">
          Statements often carry account details above the table, so this is
          rarely the first row.
        </p>
      </div>

      ${column("date", "Date", "The date the transaction happened.", true)}
      ${column("narration", "Description", "Whatever the bank calls the other party.", true)}

      <fieldset>
        <legend>The amount</legend>
        <p class="field-hint" style="margin-top:0">
          Most Indian statements use separate withdrawal and deposit columns.
          Some use one signed column instead — fill in whichever your file has.
        </p>
        ${column("debit", "Money out", "The withdrawal or debit column.")}
        ${column("credit", "Money in", "The deposit or credit column.")}
        ${column("amount", "Or one signed column", "Negative for money out.")}
      </fieldset>

      <fieldset>
        <legend>Optional</legend>
        ${column("reference", "Reference number", "Used to match the same transaction arriving twice.")}
        ${column("balance", "Running balance", "Not used for anything yet; recorded if present.")}
      </fieldset>

      <div class="field">
        <label for="profile_name">Remember this as</label>
        <input id="profile_name" name="profile_name" required placeholder="HDFC Savings statement">
        <p class="field-hint">Next month's file with these columns will import without asking.</p>
      </div>

      <button class="button-primary" type="submit">Read the file</button>
    </form>
  `;
}

export function renderImport(opts: {
  accounts: Account[];
  batches: ImportBatch[];
  profiles: { id: string; name: string; last_used_at: string | null }[];
  /** F28.2: the pointer disappears with the module rather than 404ing. */
  casEnabled: boolean;
  /** `04` §3.3 · What each bank puts on its statement password. */
  banks: { id: string; name: string; passwordHint: string }[];
  error?: string | null;
  preview?: {
    accountId: string;
    fileName: string;
    headers: string[];
    rows: number;
    errors: { rowNumber: number; cells: string[]; reason: string }[];
  } | null;
}): SafeHtml {
  return html`
    <h1>Import a statement</h1>
    <section class="card">
      <h2>A statement PDF</h2>
      <p class="faint" style="margin-top:-.25rem">
        HDFC, ICICI, Axis and SBI are recognised automatically. Anything else
        still works — you name its columns once and it is remembered.
      </p>
      <form method="post" action="/import/pdf" enctype="multipart/form-data">
        <div class="field">
          <label for="pdf-account">Which account?</label>
          <select id="pdf-account" name="account_id" required>
            ${opts.accounts.map((a) => html`<option value="${a.id}">${a.name}</option>`)}
          </select>
        </div>
        <div class="field">
          <label for="pdf-file">The statement</label>
          <input id="pdf-file" name="statement" type="file" accept="application/pdf,.pdf" required>
        </div>
        <div class="field">
          <label for="pdf-password">Its password</label>
          <input id="pdf-password" name="password" type="password"
                 autocomplete="off" spellcheck="false">
          <p class="field-hint">Leave empty if it opens without one. It is never saved.</p>
          <details style="margin-top:.4rem">
            <summary class="faint">What is my statement password?</summary>
            <ul class="faint">
              ${opts.banks.map((b) => html`<li><strong>${b.name}</strong> — ${b.passwordHint}</li>`)}
            </ul>
            <p class="faint">
              These are what each bank's own email says. If none of them work,
              check the email the statement arrived in.
            </p>
          </details>
        </div>
        <button class="button-primary" type="submit">Read it</button>
      </form>
    </section>

    ${when(opts.casEnabled, () => html`
      <p class="muted">
        This page reads bank and card statements as CSV. A
        <a href="/portfolio/cas">CDSL CAS</a> — the monthly one covering your
        mutual funds — is a PDF and goes in over there.
      </p>
    `)}
    ${when(opts.error, () => html`<p class="notice notice-error">${opts.error}</p>`)}

    <form method="post" action="/import" class="card" enctype="multipart/form-data">
      <div class="field">
        <label for="account_id">Which account is this statement for?</label>
        <select id="account_id" name="account_id" required>
          ${opts.accounts.map((a) => html`<option value="${a.id}">${a.nickname || a.name}</option>`)}
        </select>
      </div>

      <div class="field">
        <label for="csv">Paste the CSV, or upload it</label>
        <textarea id="csv" name="csv" rows="8"
                  placeholder="Date,Narration,Withdrawal Amt.,Deposit Amt.&#10;01-08-2026,SALARY,,145000.00"></textarea>
        <p class="field-hint">
          The columns are worked out from the header row, wherever it happens to be.
          Separate debit and credit columns, a single signed column, Indian grouping and
          Cr/Dr suffixes are all understood.
        </p>
      </div>

      <div class="field">
        <label for="file_name">File name <span class="faint">(optional)</span></label>
        <input id="file_name" name="file_name" placeholder="hdfc-august.csv">
      </div>

      <button class="button-primary" type="submit">Read it</button>
      <p class="field-hint">
        Nothing goes into your ledger yet — every row lands in Review first.
      </p>
    </form>

    ${when(opts.profiles.length > 0, () => html`
      <section class="card">
        <h2>Saved column mappings</h2>
        <p class="faint" style="margin-top:-.25rem">
          Recognised automatically by their column names, so a file from one of
          these banks imports without setting anything up.
        </p>
        ${opts.profiles.map(
          (p) => html`
            <form method="post" action="/import/profiles/${p.id}/delete"
                  class="row-between" style="padding:.4rem 0;border-top:1px solid var(--border)">
              <span>
                ${p.name}
                ${when(p.last_used_at, () => html`
                  <span class="faint">· last used ${p.last_used_at!.slice(0, 10)}</span>
                `)}
              </span>
              <button class="button-small button-quiet" type="submit">Forget</button>
            </form>
          `,
        )}
      </section>
    `)}

    ${when(opts.batches.length > 0, () => html`
      <section class="card">
        <h2>Import log</h2>
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">File</th>
                <th scope="col" class="num">Read</th>
                <th scope="col" class="num">Staged</th>
                <th scope="col" class="num">Duplicates</th>
                <th scope="col" class="num">Errors</th>
                <th scope="col"></th>
              </tr>
            </thead>
            <tbody>
              ${opts.batches.map(
                (b) => html`
                  <tr>
                    <td>${formatDate(b.created_at.slice(0, 10))}</td>
                    <td>${b.file_name ?? b.adapter}</td>
                    <td class="num">${b.rows_read}</td>
                    <td class="num">${b.created_count}</td>
                    <td class="num">${b.duplicate_count}</td>
                    <td class="num">${b.error_count}</td>
                    <td>
                      ${b.undone_at
                        ? html`<span class="chip">undone</span>`
                        : html`
                            <form method="post" action="/import/undo">
                              <input type="hidden" name="batch_id" value="${b.id}">
                              <button class="button-small" type="submit">Undo</button>
                            </form>
                          `}
                    </td>
                  </tr>
                `,
              )}
            </tbody>
          </table>
        </div>
        <p class="field-hint">
          Undoing removes only what that import created, and leaves anything you've
          edited since — those are listed rather than discarded.
        </p>
      </section>
    `)}
  `;
}
