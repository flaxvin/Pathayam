/**
 * How often a schedule happens — including the ones that fall on a weekday.
 *
 * Both schedule forms hard-coded five options out of the eight the app knows,
 * so half-yearly was unreachable and `monthly-nth-weekday` was unreachable
 * *and* unimplemented. One control now renders all of them, which is also what
 * stops the two forms drifting apart again.
 *
 * The weekday pair is rendered always and hidden by the client when it does not
 * apply, rather than being conditionally absent. A field that is present but
 * hidden still posts what it holds, so switching to "on a weekday" and back
 * does not lose the choice — and the server clears the pair anyway whenever the
 * recurrence is something else, so nothing stale can survive a save.
 */

import { html, raw } from "../../http/html.ts";
import type { SafeHtml } from "../../http/html.ts";
import {
  RECURRENCES, SCHEDULE_HUMAN_RECURRENCE, type Recurrence,
} from "../../domain/schedules.ts";
import { WEEKDAY_NAMES, WEEKDAY_ORDINAL_NAMES, type WeekdayOrdinal } from "../../core/dates.ts";

const ORDINALS: WeekdayOrdinal[] = [1, 2, 3, 4, -1];

export function renderRecurrence(opts: {
  /** Distinguishes the controls when a page carries several forms. */
  idPrefix: string;
  value?: Recurrence | null;
  ordinal?: number | null;
  weekday?: number | null;
  /** The schedules list packs its fields tightly; the new-schedule form does not. */
  compact?: boolean;
}): SafeHtml {
  const selected = opts.value ?? "monthly";
  const ordinal = opts.ordinal ?? 1;
  const weekday = opts.weekday ?? 0;
  const isWeekday = selected === "monthly-nth-weekday";
  const labelStyle = opts.compact ? ' style="font-size:.75rem"' : "";
  const fieldStyle = opts.compact ? ' style="margin:0"' : "";

  return html`
    <div class="field"${raw(fieldStyle)}>
      <label${raw(labelStyle)} for="${opts.idPrefix}recurrence">How often</label>
      <select id="${opts.idPrefix}recurrence" name="recurrence" data-recurrence>
        ${RECURRENCES.map((r) => html`
          <option value="${r}" ${raw(r === selected ? "selected" : "")}>
            ${SCHEDULE_HUMAN_RECURRENCE[r]}
          </option>
        `)}
      </select>
    </div>

    <div class="field"${raw(fieldStyle)} data-weekday-fields ${raw(isWeekday ? "" : "hidden")}>
      <label${raw(labelStyle)} for="${opts.idPrefix}recurrence_ordinal">Which weekday</label>
      <div class="row" style="gap:.4rem">
        <select id="${opts.idPrefix}recurrence_ordinal" name="recurrence_ordinal"
                style="max-width:7rem">
          ${ORDINALS.map((o) => html`
            <option value="${String(o)}" ${raw(o === ordinal ? "selected" : "")}>
              ${WEEKDAY_ORDINAL_NAMES[o]}
            </option>
          `)}
        </select>
        <select id="${opts.idPrefix}recurrence_weekday" name="recurrence_weekday"
                aria-label="Day of the week" style="max-width:9rem">
          ${WEEKDAY_NAMES.map((name, i) => html`
            <option value="${String(i)}" ${raw(i === weekday ? "selected" : "")}>${name}</option>
          `)}
        </select>
      </div>
    </div>
  `;
}
