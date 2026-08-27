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
import type { CategoryView } from "../viewmodel.ts";
import type { Account } from "../../domain/accounts.ts";

export interface ReviewData {
  staged: StagedRow[];
  uncategorised: {
    id: string; date: IsoDate; amount: Paise; payee: string | null; account: string;
  }[];
  overspent: CategoryView[];
  unfundedCards: { accountId: string; name: string; unfunded: Paise; categoryId: string }[];
  brokenCheckpoints: { accountId: string; name: string; asOf: IsoDate; reason: string | null }[];
  proposedRules: { id: string; name: string; because: string | null }[];
  categories: CategoryView[];
  bufferReading: string;
  month: string;
}

export function renderReview(data: ReviewData): SafeHtml {
  const total =
    data.staged.length + data.uncategorised.length + data.overspent.length +
    data.unfundedCards.length + data.brokenCheckpoints.length + data.proposedRules.length;

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
    ${when(data.overspent.length > 0, () => renderOverspent(data))}
    ${when(data.unfundedCards.length > 0, () => renderUnfundedCards(data))}
    ${when(data.brokenCheckpoints.length > 0, () => renderBrokenCheckpoints(data))}
    ${when(data.proposedRules.length > 0, () => renderProposedRules(data))}
  `;
}

function renderStaged(data: ReviewData): SafeHtml {
  const duplicates = data.staged.filter((r) => r.duplicate_of_id !== null);
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
          keeping both is one tap.
        </p>
        ${duplicates.map((row) => renderDuplicateRow(row, data.categories))}
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
        <select id="cat-${row.id}" name="category_id" style="flex:1;min-width:12rem">
          <option value="">Uncategorised</option>
          ${categories
            .filter((c) => !c.isPaymentCategory && !c.hidden)
            .map(
              (c) => html`
                <option value="${c.id}" ${raw(c.id === row.category_id ? "selected" : "")}>
                  ${c.name}
                </option>
              `,
            )}
        </select>
        <button class="button-primary button-small" type="submit">Approve</button>
        <button class="button-small" type="submit" formaction="/review/reject">Dismiss</button>
      </div>
    </form>
  `;
}

/** S4 §2: pairs side by side, with the match reason stated. */
function renderDuplicateRow(row: StagedRow, categories: CategoryView[]): SafeHtml {
  return html`
    <form method="post" action="/review/merge"
          style="padding:.75rem 0;border-top:1px solid var(--border)">
      <input type="hidden" name="staged_id" value="${row.id}">

      <p class="notice notice-warning" style="margin-bottom:.5rem">${row.duplicate_reason}</p>

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

function renderUncategorised(data: ReviewData): SafeHtml {
  return html`
    <section class="card">
      <h2>Uncategorised <span class="chip">${data.uncategorised.length}</span></h2>
      <p class="faint" style="margin-top:-.25rem">
        These are in the ledger and already affect your balances, but no envelope
        has recorded them.
      </p>
      ${data.uncategorised.map(
        (t) => html`
          <div class="row-between" style="padding:.5rem 0;border-top:1px solid var(--border)">
            <div>
              <a href="/transaction/${t.id}">${t.payee ?? "Unknown payee"}</a>
              <div class="faint">${formatDate(t.date)} · ${t.account}</div>
            </div>
            <strong class="amount ${t.amount < 0 ? "amount-negative" : ""}">
              ${formatPaise(t.amount)}
            </strong>
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
                 href="/move?to=${c.id}&amount=${-c.state.balance}&month=${data.month}">Cover</a>
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
               href="/move?to=${card.categoryId}&amount=${card.unfunded}&month=${data.month}">Fund it</a>
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
      ${data.proposedRules.map(
        (r) => html`
          <form method="post" action="/rules/confirm"
                class="row-between" style="padding:.5rem 0;border-top:1px solid var(--border)">
            <input type="hidden" name="rule_id" value="${r.id}">
            <span>
              ${r.name}
              <!-- N9: state what it was inferred from, never just the conclusion. -->
              ${when(r.because, () => html`<div class="faint">${r.because}</div>`)}
            </span>
            <span class="row">
              <button class="button-small button-primary" type="submit">Use it</button>
              <button class="button-small" type="submit" formaction="/rules/dismiss">No thanks</button>
            </span>
          </form>
        `,
      )}
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
