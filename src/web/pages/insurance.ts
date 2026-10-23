/**
 * INSURANCE-1 · The policy register.
 *
 * One list of what the household is insured for, what it costs and when it is
 * next due, with lapsed and ended policies kept below rather than deleted — a
 * lapsed term policy is a fact worth remembering. Marking a premium paid moves
 * its due date on and posts nothing; the money is recorded where all money is,
 * and a link to the Add form sits beside the button for that.
 */

import { html, raw, when, type SafeHtml } from "../../http/html.ts";
import { formatPaise, type Paise } from "../../core/money.ts";
import { formatDate, formatFiscalYear, type IsoDate } from "../../core/dates.ts";
import {
  KIND_LABELS, FREQUENCY_LABELS, TAX_GROUP_LABELS, POLICY_KINDS, PREMIUM_FREQUENCIES, TAX_GROUPS,
  isCurrent, type Policy, type PolicyTaxSuggestion,
} from "../../domain/insurance.ts";
import { renderHolderFields } from "./portfolio.ts";

type Named = { id: string; name: string };

const rupeesValue = (p: Paise | null | undefined): string =>
  p === null || p === undefined ? "" : (p / 100).toFixed(2);

function policyForm(opts: {
  action: string;
  policy?: Policy;
  members: Named[];
  envelopes: Named[];
  submit: string;
}): SafeHtml {
  const p = opts.policy;
  const sel = (on: boolean) => raw(on ? "selected" : "");
  return html`
    <form method="post" action="${opts.action}">
      ${renderHolderFields(opts.members, { holder: p?.holder_member_id, visibility: p?.visibility })}
      <div class="grid-2">
        <div class="field">
          <label for="ins-insurer">Insurer</label>
          <input id="ins-insurer" name="insurer" required value="${p?.insurer ?? ""}" placeholder="Star Health">
        </div>
        <div class="field">
          <label for="ins-kind">Kind</label>
          <select id="ins-kind" name="kind">
            ${POLICY_KINDS.map((k) => html`<option value="${k}" ${sel(p?.kind === k)}>${KIND_LABELS[k]}</option>`)}
          </select>
        </div>
      </div>
      <div class="field">
        <label for="ins-number">Policy number</label>
        <input id="ins-number" name="policy_number" autocomplete="off"
               placeholder="${p?.policy_last4 ? `Ends ${p.policy_last4} — leave blank to keep` : "Optional"}">
        <p class="field-hint">
          Only the last four characters are kept. They are enough to tell two
          policies apart and to match a premium notice; the whole number is what
          an insurer asks for to change a nominee or start a claim, and it is
          safer on the policy document than in a database whose export travels.
        </p>
      </div>
      <div class="grid-2">
        <div class="field">
          <label for="ins-premium">Premium</label>
          <input id="ins-premium" name="premium" inputmode="decimal" required value="${rupeesValue(p?.premium)}">
        </div>
        <div class="field">
          <label for="ins-frequency">Paid</label>
          <select id="ins-frequency" name="frequency">
            ${PREMIUM_FREQUENCIES.map((f) => html`
              <option value="${f}" ${sel((p?.frequency ?? "yearly") === f)}>${FREQUENCY_LABELS[f]}</option>
            `)}
          </select>
        </div>
      </div>
      <div class="grid-2">
        <div class="field">
          <label for="ins-sum">Sum assured or insured</label>
          <input id="ins-sum" name="sum_assured" inputmode="decimal" value="${rupeesValue(p?.sum_assured)}" placeholder="Optional">
        </div>
        <div class="field">
          <label for="ins-next">Next premium or renewal due</label>
          <input id="ins-next" name="next_due" type="date" autocomplete="off" value="${p?.next_due ?? ""}">
        </div>
      </div>
      <div class="grid-2">
        <div class="field">
          <label for="ins-start">Started</label>
          <input id="ins-start" name="start_date" type="date" autocomplete="off" value="${p?.start_date ?? ""}">
        </div>
        <div class="field">
          <label for="ins-end">Ends</label>
          <input id="ins-end" name="end_date" type="date" autocomplete="off" value="${p?.end_date ?? ""}">
        </div>
      </div>
      <div class="grid-2">
        <div class="field">
          <label for="ins-covered">Who it covers</label>
          <input id="ins-covered" name="covered" value="${p?.covered ?? ""}" placeholder="Optional — Priya, Ravi, Anu">
        </div>
        <div class="field">
          <label for="ins-nominee">Nominee</label>
          <input id="ins-nominee" name="nominee" value="${p?.nominee ?? ""}" placeholder="Optional">
        </div>
      </div>
      <div class="grid-2">
        <div class="field">
          <label for="ins-tax">Counts toward</label>
          <select id="ins-tax" name="tax_group">
            ${TAX_GROUPS.map((g) => html`<option value="${g}" ${sel((p?.tax_group ?? "none") === g)}>${TAX_GROUP_LABELS[g]}</option>`)}
          </select>
          <label class="row" style="gap:.5rem;margin-top:.5rem">
            <input type="checkbox" name="senior" value="1" ${raw(p?.senior ? "checked" : "")}>
            Covers a senior citizen (80D only)
          </label>
          <p class="field-hint">
            Life cover counts toward 80C, health cover toward 80D. The tax page
            adds up the premiums of the policies you hold, for whichever year it
            is showing.
          </p>
        </div>
        <div class="field">
          <label for="ins-envelope">Usually paid from</label>
          <select id="ins-envelope" name="category_id">
            <option value="">No particular envelope</option>
            ${opts.envelopes.map((e) => html`<option value="${e.id}" ${sel(p?.category_id === e.id)}>${e.name}</option>`)}
          </select>
        </div>
      </div>
      <div class="field">
        <label for="ins-note">Note</label>
        <input id="ins-note" name="note" value="${p?.note ?? ""}" placeholder="Optional">
      </div>
      <button class="button-primary" type="submit">${opts.submit}</button>
    </form>
  `;
}

function statusWords(p: Policy, today: IsoDate): string | null {
  if (p.status === "lapsed") return `Lapsed${p.closed_on ? ` ${formatDate(p.closed_on)}` : ""}`;
  if (p.status === "ended") return `Ended${p.closed_on ? ` ${formatDate(p.closed_on)}` : ""}`;
  if (p.end_date && p.end_date < today) return `Ended ${formatDate(p.end_date)}`;
  return null;
}

export function renderInsurance(opts: {
  policies: Policy[];
  members: Named[];
  envelopes: Named[];
  today: IsoDate;
}): SafeHtml {
  const memberName = (id: string | null) =>
    opts.members.length > 1 && id ? opts.members.find((m) => m.id === id)?.name ?? null : null;
  const envelopeName = (id: string | null) => (id ? opts.envelopes.find((e) => e.id === id)?.name ?? null : null);
  const current = opts.policies.filter((p) => isCurrent(p, opts.today));
  const past = opts.policies.filter((p) => !isCurrent(p, opts.today));
  const yearly = current.reduce((sum, p) => {
    const perYear = { monthly: 12, quarterly: 4, "half-yearly": 2, yearly: 1, single: 0 }[p.frequency];
    return sum + p.premium * perYear;
  }, 0) as Paise;

  const row = (p: Policy) => html`
    <div style="padding:.7rem 0;border-top:1px solid var(--border)">
      <div class="row-between">
        <div>
          <strong>${p.insurer}</strong> <span class="faint">${KIND_LABELS[p.kind]}</span>
          ${when(p.policy_last4, () => html`<span class="faint">··${p.policy_last4}</span>`)}
          ${when(memberName(p.holder_member_id), () => html`<span class="chip">${memberName(p.holder_member_id)}</span>`)}
          ${when(p.visibility === "private", () => html`<span class="chip">private</span>`)}
          ${when(p.tax_group !== "none", () => html`<span class="chip">${p.tax_group === "80c" ? "80C" : "80D"}${p.senior ? " · senior" : ""}</span>`)}
          <div class="faint">
            ${formatPaise(p.premium)} ${FREQUENCY_LABELS[p.frequency].toLowerCase()}
            ${when(p.sum_assured !== null, () => html` · cover ${formatPaise(p.sum_assured!)}`)}
            ${when(p.covered, () => html` · covers ${p.covered}`)}
            ${when(envelopeName(p.category_id), () => html` · from ${envelopeName(p.category_id)}`)}
          </div>
          ${when(statusWords(p, opts.today), () => html`<div class="faint">${statusWords(p, opts.today)}</div>`)}
        </div>
        <div style="text-align:right">
          ${isCurrent(p, opts.today) && p.next_due
            ? html`<div class="${p.next_due < opts.today ? "amount-negative" : ""}">Due ${formatDate(p.next_due)}</div>`
            : html``}
          <a class="button button-small" href="/insurance/${p.id}">Open</a>
        </div>
      </div>
    </div>
  `;

  return html`
    <h1>Insurance</h1>
    <p class="muted">
      What the household is insured for, what it costs and when it is next due.
      Renewals show on the Overview's "Due soon"; marking one paid moves its
      date on and posts nothing, because the payment is recorded where all
      money is.
    </p>

    ${opts.policies.length === 0
      ? html`<div class="card empty-state"><p>No policies recorded yet.</p></div>`
      : html`
          ${when(current.length > 0, () => html`
            <section class="card">
              <div class="row-between">
                <h2>In force</h2>
                <span class="faint">${formatPaise(yearly)} a year in regular premiums</span>
              </div>
              ${current.map(row)}
            </section>
          `)}
          ${when(past.length > 0, () => html`
            <section class="card">
              <h2>Lapsed &amp; ended</h2>
              ${past.map(row)}
            </section>
          `)}
        `}

    <section class="card">
      <h2>Record a policy</h2>
      ${policyForm({ action: "/insurance/new", members: opts.members, envelopes: opts.envelopes, submit: "Add the policy" })}
    </section>
  `;
}

export function renderPolicy(opts: {
  policy: Policy;
  members: Named[];
  envelopes: Named[];
  today: IsoDate;
}): SafeHtml {
  const p = opts.policy;
  const running = isCurrent(p, opts.today);
  return html`
    <h1>${p.insurer} <span class="faint">${KIND_LABELS[p.kind]}</span></h1>

    <section class="card">
      <div class="row-between">
        <div>
          <div class="faint">${FREQUENCY_LABELS[p.frequency]} premium</div>
          <div class="figure">${formatPaise(p.premium)}</div>
          ${when(statusWords(p, opts.today), () => html`<div class="faint">${statusWords(p, opts.today)}</div>`)}
        </div>
        <div style="text-align:right" class="faint">
          ${p.next_due && running ? html`Next due ${formatDate(p.next_due)}` : html`Nothing due`}
          ${when(p.policy_last4, () => html`<br>Policy ending ${p.policy_last4}`)}
        </div>
      </div>
      ${when(running && p.next_due !== null, () => html`
        <div class="row" style="gap:.5rem;margin-top:.75rem;flex-wrap:wrap">
          <form method="post" action="/insurance/${p.id}/paid">
            <button type="submit">Mark this premium paid</button>
          </form>
          <a class="button button-quiet" href="/add">Record the payment</a>
        </div>
        <p class="field-hint">
          Marking it paid moves the due date on by the frequency and posts
          nothing. If the payment is not already in the register, record it there.
        </p>
      `)}
    </section>

    <section class="card">
      <h2>Details</h2>
      ${policyForm({
        action: `/insurance/${p.id}/edit`, policy: p, members: opts.members,
        envelopes: opts.envelopes, submit: "Save changes",
      })}
    </section>

    <section class="card">
      <h2>${running ? "If it stops" : "Status"}</h2>
      ${running
        ? html`
            <p class="faint">A lapsed or ended policy is kept, listed apart, with nothing due on it.</p>
            <div class="row" style="gap:.5rem;flex-wrap:wrap">
              <form method="post" action="/insurance/${p.id}/status">
                <input type="hidden" name="status" value="lapsed">
                <button type="submit">Mark lapsed</button>
              </form>
              <form method="post" action="/insurance/${p.id}/status">
                <input type="hidden" name="status" value="ended">
                <button type="submit">Mark ended</button>
              </form>
            </div>
          `
        : html`
            <form method="post" action="/insurance/${p.id}/status">
              <input type="hidden" name="status" value="active">
              <button type="submit">Reinstate it</button>
            </form>
          `}
      <form method="post" action="/insurance/${p.id}/delete" style="margin-top:1rem">
        <button class="button-danger button-small" type="submit">Delete — recorded by mistake</button>
      </form>
    </section>
  `;
}

/**
 * The tax page's "from your policies" line, beside the 80C and 80D inputs.
 *
 * Shown only when the member holds a policy filed under one of them. "Use
 * these" reloads the page with the figures filled in — raised to the policies',
 * never lowered — and nothing is saved until the form is.
 */
export function renderPolicySuggestion(opts: {
  fy: number;
  suggestion: PolicyTaxSuggestion;
  applied: boolean;
}): SafeHtml {
  const s = opts.suggestion;
  if (s.lines.length === 0) return html``;
  return html`
    <div class="notice ${opts.applied ? "notice-warning" : "notice-info"}">
      <strong>From your policies, ${formatFiscalYear(opts.fy)}:</strong>
      80C ${formatPaise(s.s80c)} · 80D ${formatPaise(s.s80d)}${s.s80dSenior ? " (senior)" : ""}
      · 80D parents ${formatPaise(s.s80dParents)}${s.s80dParentsSenior ? " (senior)" : ""}.
      <span class="faint">
        The premiums falling due this year on
        ${s.lines.map((l, i) => html`${i > 0 ? ", " : ""}<a href="/insurance/${l.id}">${l.name}</a>`)}.
      </span>
      ${opts.applied
        ? html`<br>Filled in below where they were higher than your figures. Nothing is saved until you press Save.`
        : html`<br><a href="/tax?fy=${opts.fy}&amp;from=policies">Use these figures</a>
            <span class="faint">— raises each figure below to the policies', never lowers it, and saves nothing on its own.</span>`}
    </div>
  `;
}
