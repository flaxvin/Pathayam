/**
 * `08` S5 · The month-close ritual, and `02` F14 · the digest.
 *
 * S5's case for it is behavioural: "budgeting works when it is a ritual; the
 * app currently has no moment that feels like one." So this screen is written
 * as a moment rather than a report — it says what the month did in the order a
 * person asks it, and ends with the only question that matters next, which is
 * whether the new month is funded.
 *
 * N18 throughout: it does not congratulate and it does not scold. A month where
 * more went out than came in is stated, once, without adjectives.
 */

import { html, when, type SafeHtml } from "../../http/html.ts";
import { formatPaise, type Paise } from "../../core/money.ts";
import { formatMonth, formatDate, type MonthKey } from "../../core/dates.ts";
import type { MonthCloseView, ClosedMonth } from "../../domain/month-close.ts";
import type { DigestItem, DigestKind } from "../../domain/digest.ts";
import { DIGEST_KINDS, DIGEST_LABELS } from "../../domain/digest.ts";

export function renderMonthClose(view: MonthCloseView): SafeHtml {
  const { outcome, next } = view;

  return html`
    <h1>Closing ${formatMonth(view.month)}</h1>

    ${when(view.commitments.length > 0, () => html`
      <!-- 15 §6.1 · The household's close reports what each of you put in. -->
      <section class="card">
        <h2>What each of you put in</h2>
        <table class="table">
          <thead>
            <tr>
              <th scope="col">Whose</th>
              <th scope="col" class="numeric">Put in</th>
              <th scope="col" class="numeric">Spent</th>
              <th scope="col">Where it ended</th>
            </tr>
          </thead>
          <tbody>
            ${view.commitments.map(
              (c) => html`
                <tr>
                  <th scope="row">${c.name}</th>
                  <td class="numeric">${formatPaise(c.committed)}</td>
                  <td class="numeric">${formatPaise(c.spent)}</td>
                  <td>
                    ${c.standing === "ahead"
                      ? html`<span class="chip">put in more than planned</span>`
                      : c.standing === "behind"
                        ? html`<span class="faint">some still to spend</span>`
                        : html`<span class="faint">square</span>`}
                  </td>
                </tr>
              `,
            )}
          </tbody>
        </table>
        <p class="faint">
          Nothing here is settled by closing the month. A commitment carries
          forward like any envelope — <a href="/household">the household page</a>
          is where you square up.
        </p>
      </section>
    `)}

    ${when(view.stillRunning, () => html`
      <p class="notice notice-warning">
        This month is not over yet. You can still close it — nothing is locked,
        and anything that arrives later can be added — but the figures below
        will change.
      </p>
    `)}

    ${when(view.closedAt, () => html`
      <div class="notice notice-info row-between" style="align-items:center">
        <span>
          Already closed on ${formatDate(view.closedAt!.slice(0, 10) as never)}
          ${when(view.closedBy, () => html` by ${view.closedBy}`)}.
          Closing it again just refreshes the figures.
        </span>
        <!-- B51: reopenMonth shipped, but nothing rendered a control for it. -->
        <form method="post" action="/months/${view.month}/reopen" style="display:inline">
          <button class="button-small" type="submit">Reopen</button>
        </form>
      </div>
    `)}

    <section class="card">
      <h2>What the month did</h2>
      <div class="grid-2">
        <div>
          <div class="faint">Came in</div>
          <div class="figure">${formatPaise(outcome.income)}</div>
        </div>
        <div>
          <div class="faint">Went out</div>
          <div class="figure">${formatPaise(outcome.spending)}</div>
        </div>
      </div>

      <p style="margin-top:.75rem">
        ${outcome.net >= 0
          ? html`You ended <strong>${formatPaise(outcome.net)}</strong> ahead`
          : html`You spent <strong>${formatPaise(Math.abs(outcome.net) as Paise)}</strong>
                 more than came in`}
        across ${outcome.transactionCount}
        ${outcome.transactionCount === 1 ? "transaction" : "transactions"}.
        ${when(outcome.savingsRate !== null && outcome.savingsRate > 0, () => html`
          That is ${Math.round(outcome.savingsRate! * 100)}% of what came in.
        `)}
      </p>

      <p class="field-hint">
        Transfers between your own accounts are left out of both figures — the
        same money in a different place is neither income nor spending.
      </p>
    </section>

    ${when(outcome.biggestCategories.length > 0, () => html`
      <section class="card">
        <h2>Where it went</h2>
        <table>
          <tbody>
            ${outcome.biggestCategories.map(
              (c) => html`
                <tr>
                  <td>${c.name}</td>
                  <td class="numeric">${formatPaise(c.amount)}</td>
                </tr>
              `,
            )}
          </tbody>
        </table>
      </section>
    `)}

    ${when(outcome.overspent.length > 0, () => html`
      <section class="card">
        <h2>What went over</h2>
        <table>
          <tbody>
            ${outcome.overspent.map(
              (c) => html`
                <tr>
                  <td>${c.name}</td>
                  <td class="numeric negative">${formatPaise(c.amount)}</td>
                </tr>
              `,
            )}
          </tbody>
        </table>
        <p class="field-hint">
          Already handled by the rollover — this is the record, not a to-do.
        </p>
      </section>
    `)}

    ${when(view.netWorth, () => html`
      <section class="card">
        <h2>Net worth</h2>
        <p>
          ${view.netWorth!.total >= 0
            ? html`Up <strong>${formatPaise(view.netWorth!.total)}</strong>`
            : html`Down <strong>${formatPaise(Math.abs(view.netWorth!.total) as Paise)}</strong>`}
          over the month.
        </p>

        <!--
          R29.4: a net worth that rose because the rupee weakened is not the
          same achievement as one that rose because you repaid principal. The
          single figure above hides which; these four do not.
        -->
        <table>
          <tbody>
            <tr>
              <td>Money you actually saved</td>
              <td class="numeric">${formatPaise(view.netWorth!.moneySaved)}</td>
            </tr>
            <tr>
              <td>The market moved</td>
              <td class="numeric">${formatPaise(view.netWorth!.marketMovement)}</td>
            </tr>
            <tr>
              <td>Exchange rates moved</td>
              <td class="numeric">${formatPaise(view.netWorth!.fxMovement)}</td>
            </tr>
            <tr>
              <td>Debt you repaid</td>
              <td class="numeric">${formatPaise(view.netWorth!.debtRepaid)}</td>
            </tr>
          </tbody>
        </table>

        <p class="notice notice-info">${view.netWorth!.reading}</p>
        <p class="field-hint">
          Closing takes a dated snapshot, so the trend stays real rather than
          being reconstructed later from today's prices.
        </p>
      </section>
    `)}

    <section class="card">
      <h2>Is ${formatMonth(next.month)} funded?</h2>

      ${next.fullyFunded && next.unfundedCards.length === 0
        ? html`<p class="notice notice-success">Everything with a target is funded.</p>`
        : html`
            ${when(next.underfunded.categoryCount > 0, () => html`
              <p>
                <strong>${next.underfunded.categoryCount}</strong>
                ${next.underfunded.categoryCount === 1 ? "category is" : "categories are"}
                short of target, by ${formatPaise(next.underfunded.amount)} in total.
              </p>
            `)}
            ${when(next.unfundedCards.length > 0, () => html`
              <ul>
                ${next.unfundedCards.map(
                  (c) => html`
                    <li>
                      ${formatPaise(c.shortfall)} of your ${c.name} balance has no
                      envelope behind it.
                    </li>
                  `,
                )}
              </ul>
            `)}
          `}

      <p>
        <strong>${formatPaise(next.readyToAssign)}</strong> ready to assign.
        <a href="/?month=${next.month}">Go and assign it</a>
      </p>
    </section>

    <form method="post" action="/months/${view.month}/close" class="card">
      <div class="field">
        <label for="close-note">Anything worth remembering about this month?</label>
        <input id="close-note" name="note" placeholder="Optional — Diwali, the car repair, the bonus">
      </div>
      <button class="button-primary" type="submit">
        Close ${formatMonth(view.month)}
      </button>
      <a class="button button-quiet" href="/">Not now</a>
      <p class="field-hint">
        Closing records that you looked and takes a net worth snapshot. It locks
        nothing — every past month stays editable, and this undoes like anything
        else.
      </p>
    </form>
  `;
}

export function renderClosedMonths(opts: {
  months: ClosedMonth[];
  awaiting: MonthKey | null;
}): SafeHtml {
  return html`
    <h1>Month closes</h1>

    ${when(opts.awaiting, () => html`
      <div class="card">
        <p>
          <strong>${formatMonth(opts.awaiting!)}</strong> is over and not closed yet.
        </p>
        <p>
          <a class="button button-primary" href="/months/${opts.awaiting}/close">
            Close it
          </a>
        </p>
      </div>
    `)}

    ${opts.months.length === 0
      ? html`
          <div class="card empty-state">
            <p>No month has been closed yet. It is a ten-minute habit, not a
               requirement — nothing in the app depends on it.</p>
          </div>
        `
      : html`
          <section class="card">
            <table>
              <thead>
                <tr>
                  <th scope="col">Month</th>
                  <th scope="col" class="numeric">In</th>
                  <th scope="col" class="numeric">Out</th>
                  <th scope="col">Note</th>
                </tr>
              </thead>
              <tbody>
                ${opts.months.map(
                  (m) => html`
                    <tr>
                      <td><a href="/months/${m.month}/close">${formatMonth(m.month)}</a></td>
                      <td class="numeric">${formatPaise(m.income)}</td>
                      <td class="numeric">${formatPaise(m.spending)}</td>
                      <td class="faint">${m.note ?? ""}</td>
                    </tr>
                  `,
                )}
              </tbody>
            </table>
          </section>
        `}
  `;
}

// ---------------------------------------------------------------------------
// `02` F14 · The digest
// ---------------------------------------------------------------------------

/**
 * The digest, shown on next open. E12 settles that this and the badge are the
 * only notification channels there are.
 */
export function renderDigest(items: DigestItem[]): SafeHtml {
  if (items.length === 0) return html``;

  return html`
    <section class="card">
      <h2>Worth knowing <span class="chip">${items.length}</span></h2>
      ${items.map(
        (item) => html`
          <a href="${item.href}"
             style="display:block;padding:.55rem 0;border-top:1px solid var(--border);text-decoration:none;color:inherit">
            ${when(item.urgent, () => html`<span class="chip chip-warning">Now</span> `)}
            ${item.text}
          </a>
        `,
      )}
      <p class="field-hint">
        <a href="/settings#notifications">Choose which of these you want</a>.
      </p>
    </section>
  `;
}

/** F14.2 · Individually toggleable per member. */
export function renderDigestSettings(muted: Set<DigestKind>): SafeHtml {
  return html`
    <section class="card" id="notifications">
      <h2>What you want to be told</h2>
      <p class="faint" style="margin-top:-.25rem">
        These appear in the app when you open it. There are no push
        notifications, no email, and nothing that arrives while the app is
        closed — by design.
      </p>
      <form method="post" action="/settings/digest">
        ${DIGEST_KINDS.map(
          (kind) => html`
            <div class="field">
              <label>
                <input type="checkbox" name="kind" value="${kind}"
                       ${when(!muted.has(kind), () => html`checked`)}>
                ${DIGEST_LABELS[kind]}
              </label>
            </div>
          `,
        )}
        <button type="submit">Save</button>
      </form>
    </section>
  `;
}

// ---------------------------------------------------------------------------
// `10` §3.6 · What statement passwords are worked out from
// ---------------------------------------------------------------------------

/**
 * The one screen in the app that asks for a government identifier, so it says
 * plainly what it is for, what it costs, and that nothing needs it.
 *
 * N9 and the honesty rules apply with force here: this reverses PR5, and a
 * household agreeing to it should be agreeing to the real thing rather than to
 * a reassuring summary of it.
 */
export function renderStatementIdentity(
  masked: { name: string; pan: string | null; dob: string | null; mobile: string | null } | null,
): SafeHtml {
  return html`
    <section class="card" id="statements">
      <h2>Opening statements without typing a password</h2>
      <p class="faint" style="margin-top:-.25rem">
        Indian banks do not let you pick a statement password — each works it
        out from your name, your date of birth or your PAN, and every bank picks
        differently. If you save those here, the app can work them out too.
      </p>

      <p class="notice notice-warning">
        <strong>This is worth understanding before you do it.</strong> Saving
        these is the same as saving your statement passwords, which the app
        otherwise never keeps. They are stored on your own server, are left out
        of every export, and never appear in any log — but they are stored.
        Everything works without this; you will just be asked for a password
        each time.
      </p>

      ${when(masked, () => html`
        <table>
          <tbody>
            <tr><td>Name</td><td>${masked!.name}</td></tr>
            <tr><td>PAN</td><td>${masked!.pan ?? "Not saved"}</td></tr>
            <tr><td>Date of birth</td><td>${masked!.dob ?? "Not saved"}</td></tr>
            <tr><td>Mobile</td><td>${masked!.mobile ?? "Not saved"}</td></tr>
          </tbody>
        </table>
        <form method="post" action="/settings/identity" style="margin:.6rem 0">
          <input type="hidden" name="clear" value="1">
          <button class="button-small button-danger" type="submit">Remove these</button>
        </form>
      `)}

      <form method="post" action="/settings/identity">
        <div class="field">
          <label for="id-name">Your name, as the bank prints it</label>
          <input id="id-name" name="name" required autocomplete="off"
                 value="${masked?.name ?? ""}" placeholder="Ravi Kumar">
          <p class="field-hint">Most passwords start with the first four letters of this.</p>
        </div>
        <div class="field">
          <label for="id-dob">Date of birth</label>
          <input id="id-dob" name="dob" autocomplete="off" inputmode="numeric"
                 placeholder="DDMMYYYY">
        </div>
        <div class="field">
          <label for="id-pan">PAN</label>
          <input id="id-pan" name="pan" autocomplete="off" spellcheck="false"
                 placeholder="Optional — brokers use it">
        </div>
        <div class="field">
          <label for="id-mobile">Registered mobile</label>
          <input id="id-mobile" name="mobile" autocomplete="off" inputmode="numeric"
                 placeholder="Optional — SBI's account statement uses its last five">
        </div>
        <button type="submit">Save</button>
      </form>
    </section>
  `;
}

// ---------------------------------------------------------------------------
// `04` §3.4 · The Gmail connection
// ---------------------------------------------------------------------------

/**
 * Connect / disconnect Gmail, and fetch on demand.
 *
 * Like the statement identity, this asks for a real capability — read access
 * to a mailbox — so it says plainly what it reads and what it keeps, rather
 * than a reassuring summary.
 */
export function renderGmailConnection(
  connection: { email: string; connectedAt: string; lastFetchedAt: string | null } | null,
  configured: boolean,
): SafeHtml {
  return html`
    <section class="card" id="gmail">
      <h2>Fetching statements and alerts from Gmail</h2>
      <p class="faint" style="margin-top:-.25rem">
        Your bank emails a transaction alert within seconds of a spend, and a
        statement each month. Connect Gmail and the app reads those — and only
        those — into your review queue.
      </p>

      ${when(!configured, () => html`
        <p class="notice notice-warning">
          Google sign-in is not configured on this server, so Gmail cannot be
          connected here.
        </p>
      `)}

      <p class="notice notice-warning">
        <strong>What this grants.</strong> Read-only access to your Gmail, used
        only for messages from your banks' own addresses — nothing else is ever
        opened. Only the amounts, dates and merchants are kept; the emails
        themselves are not. The access is stored on your own server, left out of
        every export, and deleted the moment you disconnect.
      </p>

      ${connection
        ? html`
            <table>
              <tbody>
                <tr><td>Connected mailbox</td><td>${connection.email}</td></tr>
                <tr><td>Since</td><td>${connection.connectedAt.slice(0, 10)}</td></tr>
                <tr><td>Last fetched</td><td>${connection.lastFetchedAt?.slice(0, 10) ?? "Never"}</td></tr>
              </tbody>
            </table>
            <div class="row" style="gap:.5rem;margin-top:.6rem">
              <form method="post" action="/gmail/fetch">
                <button class="button-primary" type="submit">Fetch now</button>
              </form>
              <form method="post" action="/gmail/disconnect">
                <button class="button-small button-danger" type="submit">Disconnect</button>
              </form>
            </div>
          `
        : html`
            ${when(configured, () => html`
              <p><a class="button button-primary" href="/gmail/connect">Connect Gmail</a></p>
            `)}
          `}
    </section>
  `;
}
