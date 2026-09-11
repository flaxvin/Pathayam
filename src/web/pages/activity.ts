/**
 * R37 · Activity — the event log, and the only place universal undo is
 * reachable from.
 *
 * The log has been append-only and complete since the first commit, and
 * `undoEvent` has had a registered handler for every entity that can be
 * changed. What was missing was a door: nothing in the web layer ever called
 * it, so an undoable event was undoable in principle and not in practice.
 *
 * R37.9 is the reason each row carries its own state rather than a bare button.
 * An undo that would discard later edits must say so and show what it would
 * discard, before it happens — never silently.
 */

import { html, when, raw, type SafeHtml } from "../../http/html.ts";
import { formatDateTime } from "../../core/dates.ts";

export interface ActivityRow {
  id: string;
  at: string;
  /** The plain-language line the mutation wrote when it happened. */
  summary: string;
  entity: string;
  action: string;
  /** Who did it — already resolved to a name. */
  actor: string;
  /** R38.9: who was really at the keyboard, when that differs. */
  onBehalfOf?: string | null;
  source: string;
  /** Null when this event is undoable; otherwise why it is not. */
  blockedReason: string | null;
  /** R37.9 · Later changes to the same record that an undo would discard. */
  supersededBy: { at: string; summary: string }[];
  /** True when this row is itself an undo of something else. */
  isUndo: boolean;
  undone: boolean;
}

const SOURCE_LABEL: Record<string, string> = {
  ui: "in the app",
  import: "from an import",
  rule: "by a rule",
  job: "by a scheduled job",
  api: "through the API",
  system: "by the app",
};

export function renderActivity(opts: {
  rows: ActivityRow[];
  entity: string | null;
  entities: string[];
  windowDays: number;
}): SafeHtml {
  return html`
    <h1>Activity</h1>
    <p class="muted">
      Every change this household has made, newest first, and nothing is ever
      edited or deleted from this list — an undo is recorded as its own entry.
      Changes from the last ${opts.windowDays} days can be undone.
    </p>

    <form method="get" action="/activity" class="row" style="gap:.5rem;align-items:flex-end;margin-bottom:1rem">
      <div class="field" style="margin:0">
        <label for="entity">Show</label>
        <select id="entity" name="entity">
          <option value="">Everything</option>
          ${opts.entities.map(
            (e) => html`
              <option value="${e}" ${raw(opts.entity === e ? "selected" : "")}>${e}</option>
            `,
          )}
        </select>
      </div>
      <button class="button-small" type="submit">Filter</button>
      ${when(opts.entity, () => html`<a class="button button-small button-quiet" href="/activity">Clear</a>`)}
    </form>

    ${opts.rows.length === 0
      ? html`<div class="card empty-state"><p>Nothing here yet.</p></div>`
      : html`
          <section class="card">
            ${opts.rows.map((row) => renderRow(row))}
          </section>
        `}
  `;
}

function renderRow(row: ActivityRow): SafeHtml {
  return html`
    <div style="padding:.7rem 0;border-top:1px solid var(--border)">
      <div class="row-between" style="gap:1rem;align-items:flex-start">
        <div style="min-width:0">
          <strong>${row.summary || `${row.action} ${row.entity}`}</strong>
          ${when(row.isUndo, () => html`<span class="chip">undo</span>`)}
          ${when(row.undone, () => html`<span class="chip chip-warning">undone</span>`)}
          <div class="faint">
            ${formatDateTime(row.at)} · ${row.actor}
            ${when(row.onBehalfOf, () => html` (as ${row.onBehalfOf})`)}
            · ${SOURCE_LABEL[row.source] ?? row.source}
          </div>
        </div>

        ${row.blockedReason
          ? html`<span class="faint" style="text-align:right;max-width:18rem">${row.blockedReason}</span>`
          : row.supersededBy.length === 0
            ? html`
                <form method="post" action="/activity/${row.id}/undo">
                  <button class="button-small" type="submit">Undo</button>
                </form>
              `
            : renderSupersededUndo(row)}
      </div>
    </div>
  `;
}

/**
 * R37.9 · When later changes touched the same record, the undo is offered only
 * behind an explicit list of what it would discard. The force flag is on the
 * form the user opens, not on the button they reach first.
 */
function renderSupersededUndo(row: ActivityRow): SafeHtml {
  return html`
    <details style="max-width:22rem">
      <summary class="linkish">Undo — ${row.supersededBy.length} later change${row.supersededBy.length === 1 ? "" : "s"}</summary>
      <p class="faint" style="margin:.5rem 0">
        This record has changed since. Undoing goes back to the state before the
        entry above, discarding these:
      </p>
      <ul class="faint" style="margin:0 0 .5rem 1rem;padding:0">
        ${row.supersededBy.map(
          (s) => html`<li>${formatDateTime(s.at)} — ${s.summary}</li>`,
        )}
      </ul>
      <form method="post" action="/activity/${row.id}/undo">
        <input type="hidden" name="force" value="1">
        <button class="button-small button-danger" type="submit">Undo anyway</button>
      </form>
    </details>
  `;
}
