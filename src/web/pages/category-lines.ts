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

import { html, raw, when, type SafeHtml } from "../../http/html.ts";
import { formatPaise, type Paise } from "../../core/money.ts";

export interface CategoryChoice {
  id: string;
  name: string;
  /** Shown beside the name where the screen knows it, as `— ₹1,200 left`. */
  balance?: Paise;
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
}): SafeHtml {
  const values = opts.values ?? [];
  const extras = opts.extraLines ?? 3;
  const split = values.length > 1;

  const options = (selected: string | null) => html`
    <option value="">—</option>
    ${opts.categories.map((c) => html`
      <option value="${c.id}" ${raw(c.id === selected ? "selected" : "")}>
        ${c.name}${c.balance !== undefined ? ` — ${formatPaise(c.balance)} left` : ""}
      </option>
    `)}
  `;

  return html`
    <div class="field">
      <label for="split_category_0">${opts.label ?? "Envelope"}</label>
      <select id="split_category_0" name="split_category_0"
              ${raw(opts.required ? "required" : "")}
              ${raw(opts.requiresCategory ? "data-requires-category" : "")}>
        ${options(values[0]?.categoryId ?? null)}
      </select>
      ${when(opts.hint, () => html`<p class="field-hint">${opts.hint}</p>`)}
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
            <label class="sr-only" for="split_category_${i + 1}">Envelope ${i + 2}</label>
            <select id="split_category_${i + 1}" name="split_category_${i + 1}" style="max-width:13rem">
              ${options(line?.categoryId ?? null)}
            </select>
            <label class="sr-only" for="split_amount_${i + 1}">Amount ${i + 2}</label>
            <input id="split_amount_${i + 1}" name="split_amount_${i + 1}"
                   class="amount-input" inputmode="decimal" style="max-width:8rem"
                   placeholder="0.00"
                   value="${line?.amount != null ? (Math.abs(line.amount) / 100).toFixed(2) : ""}">
          </div>
        `;
      })}
    </details>
  `;
}
