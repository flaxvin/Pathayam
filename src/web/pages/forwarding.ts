/**
 * FWD-3 · The forwarding address on Settings: the address, how to point a
 * mail filter at it, Gmail's confirmation code when one arrives, what arrived
 * lately, and the locked statements waiting for a password.
 */

import { html, when, type SafeHtml } from "../../http/html.ts";
import { formatDate } from "../../core/dates.ts";
import type { ForwardedMailRow, HeldStatement } from "../../forwarding/held.ts";

export interface ForwardingView {
  /** Null when the server has no INBOUND_DOMAIN or INBOUND_SECRET yet. */
  ready: boolean;
  address: string | null;
  createdAt: string | null;
  lastReceivedAt: string | null;
  confirmation: { code: string; link: string | null; receivedAt: string } | null;
  recent: ForwardedMailRow[];
  held: HeldStatement[];
  /** Whether a locked statement can be kept to retry (SECRETS_KEY is set). */
  canHold: boolean;
  /** Every bank sender the import reads, for the filter's From. */
  senders: string[];
}

const OUTCOME: Record<string, string> = {
  read: "Imported",
  nothing: "Nothing to import",
  "not-a-bank": "Not a bank sender — not opened",
  unsigned: "Signature did not check out — not imported",
  confirmation: "Gmail's confirmation code",
  held: "Locked statement kept",
};


export function renderForwarding(view: ForwardingView): SafeHtml {
  return html`
    <section class="card" id="forwarding">
      <h2>Forwarding address</h2>
      <p class="faint" style="margin-top:-.25rem">
        Forward your banks' alert and statement emails here, with a filter in
        your mail, and each one lands in Review as it arrives. Pathayam never
        has access to your mailbox: you send it the bank's mail, and nothing else.
      </p>

      ${when(!view.ready, () => html`
        <p class="notice notice-warning">
          Forwarding is not set up on this server yet: it needs a mail receiver
          and <code>INBOUND_DOMAIN</code> and <code>INBOUND_SECRET</code>
          (docs/forwarding.md).
        </p>
      `)}

      ${when(view.ready && view.address === null, () => html`
        <form method="post" action="/forwarding/create">
          <button class="button-primary" type="submit">Make my forwarding address</button>
        </form>
      `)}

      ${when(view.address !== null, () => html`
        <div class="field">
          <label for="forwarding-address">Your address</label>
          <input id="forwarding-address" type="text" readonly value="${view.address!}"
                 style="font-family:var(--mono, monospace)">
        </div>
        <p class="faint">
          Made ${formatDate(view.createdAt!.slice(0, 10))}.
          ${view.lastReceivedAt ? `Last message ${formatDate(view.lastReceivedAt.slice(0, 10))}.` : "Nothing has arrived yet."}
          Treat it like a password: anyone who has it can send mail to your Review queue.
        </p>

        ${when(view.confirmation !== null, () => html`
          <p class="notice notice-info" id="forwarding-confirmation">
            <strong>Gmail asked to confirm this address.</strong>
            Enter code <strong><code>${view.confirmation!.code}</code></strong>
            in Gmail under Settings → Forwarding and POP/IMAP${view.confirmation!.link
              ? html`, or <a href="${view.confirmation!.link}" target="_blank" rel="noopener noreferrer">open Gmail's confirmation link</a>`
              : ""}.
          </p>
        `)}

        <details>
          <summary>How to set up the filter</summary>
          <ol>
            <li><strong>Gmail:</strong> Settings → See all settings → Forwarding and POP/IMAP →
              Add a forwarding address, and paste the address above. Gmail sends a
              code here; it appears on this page within a minute. Enter it in Gmail.</li>
            <li>Then Filters and Blocked Addresses → Create a new filter. In <em>From</em>,
              paste the senders Pathayam reads (or just your own banks' from this list):
              <textarea readonly rows="3" style="width:100%;font-family:var(--mono, monospace)">${view.senders.join(" OR ")}</textarea>
              Choose <em>Forward it to</em> this address.</li>
            <li><strong>Outlook:</strong> Settings → Mail → Rules → Add new rule, condition
              <em>From</em> your banks, action <em>Forward to</em> this address.</li>
          </ol>
          <p class="faint">
            Use a filter or rule rather than the Forward button: forwarding by hand
            rewrites the message, the bank's signature no longer checks out, and the
            message is not imported. Statement passwords use the details saved under
            Statement passwords below, as an upload does.
          </p>
        </details>

        <div class="row" style="gap:.5rem;margin-top:.6rem">
          <form method="post" action="/forwarding/create"
                data-confirm="Make a new address? The current one stops taking mail at once, and your filter must be updated.">
            <button class="button-small" type="submit">Replace address</button>
          </form>
          <form method="post" action="/forwarding/remove"
                data-confirm="Turn off forwarding? Mail to this address will be refused.">
            <button class="button-small button-danger" type="submit">Turn off</button>
          </form>
        </div>
      `)}

      ${when(view.held.length > 0, () => html`
        <h3 id="forwarding-held">Locked statements waiting</h3>
        <p class="faint">
          These could not be opened with the details on file. Add what is missing
          under Statement passwords, then try again. Each is deleted when it opens,
          or after 90 days.
        </p>
        <div class="table-scroll">
          <table>
            <thead><tr><th>Arrived</th><th>From</th><th>File</th><th></th></tr></thead>
            <tbody>
              ${view.held.map((h) => html`
                <tr>
                  <td>${formatDate(h.received_at.slice(0, 10))}</td>
                  <td>${h.sender}</td>
                  <td>${h.filename}</td>
                  <td>
                    <form method="post" action="/forwarding/held/${h.id}/delete"
                          data-confirm="Delete this statement? It cannot be imported afterwards.">
                      <button class="button-small button-danger" type="submit">Delete</button>
                    </form>
                  </td>
                </tr>`)}
            </tbody>
          </table>
        </div>
        <form method="post" action="/forwarding/retry" style="margin-top:.5rem">
          <button class="button-primary" type="submit">Try them again</button>
        </form>
      `)}
      ${when(view.address !== null && !view.canHold, () => html`
        <p class="faint">
          A statement that cannot be opened on arrival is not kept on this server
          (SECRETS_KEY is not set), so save your statement details before the
          first one arrives.
        </p>
      `)}

      ${when(view.recent.length > 0, () => html`
        <h3>Lately</h3>
        <div class="table-scroll">
          <table>
            <thead><tr><th>Arrived</th><th>From</th><th>Subject</th><th>What happened</th></tr></thead>
            <tbody>
              ${view.recent.map((m) => html`
                <tr>
                  <td>${formatDate(m.received_at.slice(0, 10))}</td>
                  <td>${m.sender}</td>
                  <td>${m.subject}</td>
                  <td>${OUTCOME[m.outcome] ?? m.outcome}${m.detail && m.outcome !== "confirmation"
                    ? html`<br><span class="faint">${m.detail}</span>` : ""}</td>
                </tr>`)}
            </tbody>
          </table>
        </div>
        <p class="faint">Kept 90 days, without the messages themselves.</p>
      `)}
    </section>
  `;
}
