/**
 * The envelope control, shared by every screen that files money.
 *
 * There is no "main" category and there never really was — a transaction has
 * envelopes, and usually one. The form used to ask for a category *and* carry
 * a separate split section, which produced a box that silently meant nothing
 * while the section was open, and a long tail of questions about what it
 * should say, whether it was required, and what happened to whatever you had
 * already chosen in it.
 *
 * So the control is a list of lines:
 *
 *   · the **first carries no amount** and takes whatever the others leave;
 *   · the rest are hidden until somebody asks to split, and name an amount.
 *
 * One line is an ordinary single-envelope entry, which is what almost every
 * transaction is. Two lines make it a split without the first ever being
 * retyped — add a ₹900 line to a ₹2,400 total and the first quietly becomes
 * ₹1,500.
 *
 * That is what makes the lines unable to disagree with the total: the
 * remainder is computed rather than typed, so the arithmetic the household
 * used to have to get right, and the refusal when they did not, stop existing.
 */

import { html, raw, when, escape, type SafeHtml } from "../../http/html.ts";
import { formatPaise, type Paise } from "../../core/money.ts";

export interface CategoryChoice {
  id: string;
  name: string;
  /** Shown beside the name where the screen knows it, as `— ₹1,200 left`. */
  balance?: Paise;
  /**
   * The budget it belongs to, and that budget's name as the household reads
   * it. Given on a screen that offers envelopes from more than one budget: the
   * list is then grouped by budget, and each option says which, so the client
   * can explain a filing across budgets before it is made (15 §3.4).
   */
  budgetId?: string | null;
  budgetLabel?: string;
}

export interface CategoryLineValue {
  categoryId: string | null;
  amount: Paise | null;
}

/**
 * `extraLines` is three by default: a household splitting a bill four ways is
 * rare enough that offering more would cost every other entry some clarity.
 */
export function renderCategoryLines(opts: {
  categories: CategoryChoice[];
  /** What is already filed, first line first. */
  values?: CategoryLineValue[];
  /** Shown under the first line. */
  hint?: SafeHtml | null;
  extraLines?: number;
  /** Labels the first select, since screens word it differently. */
  label?: string;
  required?: boolean;
  /** Marks the first select for the client's money-in/out rule. */
  requiresCategory?: boolean;
  /**
   * UIQ-3 · Prefixes the element ids (never the field names), for a page that
   * renders several of these forms — one per schedule — where bare ids repeat.
   */
  idPrefix?: string;
}): SafeHtml {
  const p = opts.idPrefix ?? "";
  const values = opts.values ?? [];
  const extras = opts.extraLines ?? 3;
  const split = values.length > 1;

  const option = (c: CategoryChoice, selected: string | null) => html`
    <option value="${c.id}"${raw(c.budgetId !== undefined ? ` data-budget="${escape(c.budgetId ?? "")}"` : "")} ${raw(c.id === selected ? "selected" : "")}>
      ${c.name}${c.balance !== undefined ? ` — ${formatPaise(c.balance)} left` : ""}
    </option>
  `;
  // Grouped only when the choices really span budgets; one group is noise.
  const groups = [...new Set(opts.categories.map((c) => c.budgetLabel).filter((l): l is string => !!l))];
  const options = (selected: string | null) => html`
    <option value="">—</option>
    ${groups.length > 1
      ? groups.map((label) => html`
          <optgroup label="${label}">
            ${opts.categories.filter((c) => c.budgetLabel === label).map((c) => option(c, selected))}
          </optgroup>
        `)
      : opts.categories.map((c) => option(c, selected))}
  `;

  return html`
    <div class="field">
      <label for="${p}split_category_0">${opts.label ?? "Envelope"}</label>
      <select id="${p}split_category_0" name="split_category_0"
              ${raw(opts.required ? "required" : "")}
              ${raw(opts.requiresCategory ? "data-requires-category" : "")}>
        ${options(values[0]?.categoryId ?? null)}
      </select>
      ${when(opts.hint, () => html`<p class="field-hint" data-category-hint>${opts.hint}</p>`)}
    </div>

    <details class="field" ${raw(split ? "open" : "")}>
      <summary class="linkish">Split it across more than one</summary>
      <p class="field-hint">
        Name an amount for each extra envelope. Whatever is left over stays on
        the first — so it never has to be worked out, and the lines cannot
        disagree with the total.
      </p>
      ${Array.from({ length: extras }, (_unused, i) => {
        const line = values[i + 1];
        return html`
          <div class="row" style="gap:.4rem;margin-bottom:.35rem">
            <label class="sr-only" for="${p}split_category_${i + 1}">Envelope ${i + 2}</label>
            <select id="${p}split_category_${i + 1}" name="split_category_${i + 1}" style="max-width:13rem">
              ${options(line?.categoryId ?? null)}
            </select>
            <label class="sr-only" for="${p}split_amount_${i + 1}">Amount ${i + 2}</label>
            <input id="${p}split_amount_${i + 1}" name="split_amount_${i + 1}"
                   class="amount-input" inputmode="decimal" style="max-width:8rem"
                   placeholder="0.00"
                   value="${line?.amount != null ? (Math.abs(line.amount) / 100).toFixed(2) : ""}">
          </div>
        `;
      })}
    </details>
  `;
}
