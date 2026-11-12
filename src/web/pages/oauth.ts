/**
 * OAUTH · The page an AI app sends a member to before it may read anything.
 *
 * The app's name is its own claim — anybody can register as "Claude" — so the
 * page leads with where the answer goes, which the app cannot fake: the host
 * of its redirect URI. Then exactly what it gets (read-only, what this member
 * can see, sent to that provider) and how to take it back. The MCP spec asks
 * for the host to be shown clearly and for a warning when the app only
 * answers on this computer; both are here.
 */

import { html, when, type SafeHtml } from "../../http/html.ts";
import { aiKeyReadsNotice } from "./ai.ts";

export function renderConsent(opts: {
  clientName: string;
  redirectHost: string;
  loopbackOnly: boolean;
  memberName: string;
  /** Every authorization request parameter, carried back unchanged on the POST. */
  hidden: Record<string, string>;
  /**
   * AIW · Present when this deployment lets AI connections make changes
   * (AI_WRITE). The box is never ticked for the member, whatever the app asked.
   */
  writes?: { mode: "standard" | "full"; asked: boolean } | null;
}): SafeHtml {
  const writes = opts.writes ?? null;
  return html`
    <div style="max-width:34rem;margin:2rem auto">
      <h1>Connect ${opts.clientName}?</h1>
      <section class="card">
        <p>
          An app calling itself <strong>${opts.clientName}</strong> wants to read your budget.
          If you approve, what it reads is sent to
          <strong style="font-size:1.1em">${opts.redirectHost}</strong>.
        </p>
        ${when(opts.loopbackOnly, () => html`
          <p class="notice notice-warning">
            This app answers on your own computer (${opts.redirectHost}), and any program
            running on it could be the one asking. Approve only if you just started
            connecting it yourself.
          </p>
        `)}
        <h2>It will be able to</h2>
        <ul>
          <li>Read what you, ${opts.memberName}, can see here: the household budget and your own personal budget.</li>
          <li>Never read another member's private accounts, loans or policies.</li>
          ${writes
            ? html`<li><strong>Change nothing</strong> unless you tick the box below. Without it, its access is read-only.</li>`
            : html`<li><strong>Never change anything.</strong> Its access is read-only, whatever it asks for.</li>`}
        </ul>
        <p class="muted">
          Whatever it reads goes to that app's provider, under their terms, not ours.
          You can disconnect it any time under More → Connect an AI.
        </p>
        ${aiKeyReadsNotice({ approving: true })}
        <form method="post" action="/oauth/authorize" data-no-retry="true">
          ${Object.entries(opts.hidden).map(
            ([name, value]) => html`<input type="hidden" name="${name}" value="${value}">`,
          )}
          <div class="field">
            <label>
              <input type="checkbox" name="redact" value="1" checked>
              Mask account numbers, UPI IDs, phone numbers and PAN in what this app is sent
            </label>
          </div>
          ${when(writes, () => html`
            <div class="field">
              <label>
                <input type="checkbox" name="allow_changes" value="1">
                Also let it make changes${writes!.asked ? html` <span class="faint">(the app asked for this)</span>` : ""}
              </label>
              <p class="faint">
                It could file a transaction under an envelope, split one, write a memo, and suggest
                where a payee's spending goes.
                ${writes!.mode === "standard"
                  ? "Adding a transaction, assigning money and recording a transfer would wait in Review for you to approve."
                  : "It could also add transactions, assign money and record transfers."}
                It can never delete anything or touch loans, investments, settings or members. Every
                change is in Activity, where you can undo it, and at most 100 are made a day.
              </p>
            </div>
          `)}
          <div class="row">
            <button class="button-primary" type="submit" name="decision" value="approve">${writes ? "Approve" : "Approve read-only access"}</button>
            <button type="submit" name="decision" value="deny">Deny</button>
          </div>
        </form>
      </section>
    </div>
  `;
}

/** A request that cannot be answered at its redirect URI is answered here. */
export function renderConsentProblem(message: string): SafeHtml {
  return html`
    <div style="max-width:34rem;margin:2rem auto">
      <h1>That app could not be connected</h1>
      <section class="card">
        <p>${message}</p>
        <p>More → <a href="/tokens/ai">Connect an AI</a> lists the apps already connected.</p>
      </section>
    </div>
  `;
}
