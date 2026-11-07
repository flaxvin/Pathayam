/**
 * IMP-32 · The SafeGold statement upload and review screens.
 *
 * The same contract as the CAS screens beside them in `portfolio.ts`: the
 * password is used once and never round-trips, and the review shows every
 * row — the ones already recorded and the ones skipped too — before anything
 * is written (`04` I2).
 */

import { html, when, type SafeHtml } from "../../http/html.ts";
import { formatPaise, type Paise } from "../../core/money.ts";
import { formatDate } from "../../core/dates.ts";
import { formatGrams } from "../../import/safegold.ts";
import type { SafeGoldPlan, PlannedGoldRow } from "../../import/safegold-plan.ts";

export function renderSafeGoldUpload(opts: { error?: string | null }): SafeHtml {
  return html`
    <h1>Import a SafeGold statement</h1>
    <p class="muted">
      SafeGold's monthly statement lists the gold you bought and sold, and the
      gold you hold at the end of the month. Each purchase becomes a lot at
      what it cost you, GST included; each sale realises a gain. Nothing is
      recorded until you have seen what it would do.
    </p>

    ${when(opts.error, () => html`<p class="notice notice-error">${opts.error}</p>`)}

    <section class="card">
      <form method="post" action="/portfolio/safegold" enctype="multipart/form-data">
        <div class="field">
          <label for="statement">The statement</label>
          <input id="statement" name="statement" type="file" accept="application/pdf,.pdf" required>
          <p class="field-hint">The PDF as SafeGold mailed it.</p>
        </div>

        <div class="field">
          <label for="password">Its password</label>
          <input id="password" name="password" type="password" autocomplete="off" spellcheck="false">
          <p class="field-hint">
            The first four letters of your name in capitals, then your mobile's
            last four. Leave it empty if your details are saved in Settings. It
            is never saved.
          </p>
        </div>

        <button class="button-primary" type="submit">Read it</button>
        <a class="button button-quiet" href="/portfolio">Cancel</a>
      </form>
    </section>
  `;
}

const KIND_LABELS: Record<string, string> = { buy: "Bought", sell: "Sold", other: "Other" };

function statusChip(status: PlannedGoldRow["status"]): SafeHtml {
  return status === "new"
    ? html`<span class="chip chip-positive">New</span>`
    : status === "already-held"
      ? html`<span class="chip">Already recorded</span>`
      : html`<span class="chip chip-warning">Skipped</span>`;
}

/** A price in micro-rupees per milligram, as rupees per gram. */
function perGram(price: number | null): string {
  return price === null ? "—" : `${formatPaise(Math.round(price / 10) as Paise)}/g`;
}

export function renderSafeGoldReview(opts: { plan: SafeGoldPlan; token: string; notice?: string | null }): SafeHtml {
  const { plan } = opts;
  const mismatched = plan.statements.some((s) => s.disagreement !== null);
  const unparsed = plan.statements.flatMap((s) => s.unparsed);
  const n = plan.totals.newEntries;

  return html`
    <h1>What this SafeGold statement says</h1>
    ${when(opts.notice, () => html`<p class="notice">${opts.notice}</p>`)}
    <p class="muted">Nothing is recorded until you confirm it below.</p>

    ${plan.statements.map((s) => html`
      <section class="card">
        <div class="row-between">
          <div>
            ${s.period
              ? html`<strong>${formatDate(s.period.from)} to ${formatDate(s.period.to)}</strong>`
              : html`<strong>SafeGold statement</strong>`}
            <div class="faint">
              Opens at ${s.openingUnits === null ? "—" : formatGrams(s.openingUnits)},
              closes at ${s.closingUnits === null ? "—" : formatGrams(s.closingUnits)}
            </div>
          </div>
          ${when(s.disagreement === null && s.closingUnits !== null, () => html`
            <span class="chip chip-positive">Reconciles</span>
          `)}
        </div>
        ${when(s.disagreement !== null, () => html`
          <!-- N9 / R24.3: a discrepancy is stated, never absorbed. -->
          <p class="notice notice-warning">
            Its opening balance and rows come to
            ${formatGrams((s.closingUnits ?? 0) - s.disagreement!)}, but it closes at
            ${formatGrams(s.closingUnits ?? 0)} — a row is probably missing.
            Importing it would leave your gold disagreeing with the statement.
          </p>
        `)}
      </section>
    `)}

    ${when(unparsed.length > 0, () => html`
      <section class="card">
        <!-- IL3: never swallow a row that could not be read. -->
        <h2>Lines that did not parse <span class="chip chip-warning">${unparsed.length}</span></h2>
        <p class="faint">Nothing was guessed from these — add anything that matters by hand.</p>
        <pre class="raw-block">${unparsed.join("\n")}</pre>
      </section>
    `)}

    <form method="post" action="/portfolio/safegold/confirm">
      <input type="hidden" name="token" value="${opts.token}">
      <section class="card">
        <div class="row-between">
          <div>
            <strong>${n}</strong> ${n === 1 ? "new entry" : "new entries"}
            ${when(plan.totals.alreadyHeld > 0, () => html`
              <span class="faint">· ${plan.totals.alreadyHeld} already recorded by an earlier statement</span>
            `)}
          </div>
          <div><strong>${formatPaise(plan.totals.invested)}</strong> invested</div>
        </div>

        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">What</th>
                <th scope="col" class="numeric">Gold</th>
                <th scope="col" class="numeric">Rate</th>
                <th scope="col" class="numeric">Amount</th>
                <th scope="col" class="numeric">GST</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              ${plan.rows.map((r) => html`
                <tr class="${r.status === "new" ? "" : "faint"}">
                  <td>${formatDate(r.row.date)}${when(r.row.time, () => html` ${r.row.time}`)}</td>
                  <td>
                    ${KIND_LABELS[r.row.kind]} · ${r.row.description}
                    ${when(r.note, () => html`<div class="faint">${r.note}</div>`)}
                  </td>
                  <td class="numeric">${formatGrams(r.row.units)}</td>
                  <td class="numeric">${perGram(r.price ?? r.row.price)}</td>
                  <td class="numeric">${r.row.amount === null ? "—" : formatPaise(r.row.amount)}</td>
                  <td class="numeric">${r.row.gst ? formatPaise(r.row.gst) : "—"}</td>
                  <td>${statusChip(r.status)}</td>
                </tr>
              `)}
            </tbody>
          </table>
        </div>

        <p class="field-hint">
          Lands in ${plan.newAccount ? html`a new commodity account, “${plan.accountName}”` : plan.accountName},
          as SafeGold 24K gold, counted in milligrams. Purchases cost what the statement
          says you paid, GST included.
        </p>
        ${when(plan.ledgerGap !== null, () => html`
          <p class="notice notice-warning">
            After this, your portfolio would hold
            ${formatGrams((plan.statements[plan.statements.length - 1]?.closingUnits ?? 0) - plan.ledgerGap!)}
            of SafeGold gold; the statement says
            ${formatGrams(plan.statements[plan.statements.length - 1]?.closingUnits ?? 0)}.
            Gold bought before this statement is not in it — add those purchases by hand.
          </p>
        `)}
      </section>

      <div class="card">
        ${when(mismatched, () => html`
          <label class="row">
            <input type="checkbox" name="accept_mismatch" value="1">
            Import it anyway — record the rows it does show
          </label>
        `)}
        <button class="button-primary" type="submit">Record ${n} ${n === 1 ? "entry" : "entries"}</button>
        <a class="button button-quiet" href="/portfolio">Discard this statement</a>
        <p class="field-hint">
          The whole import undoes in one action from Activity. The statement
          itself is not kept, and neither is its password.
        </p>
      </div>
    </form>
  `;
}
