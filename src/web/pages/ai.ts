/**
 * AI-5 · Connect an AI — Settings → API tokens → Connect an AI.
 *
 * One page that answers the three questions a household has before letting an
 * AI read the budget: how do I connect it, what will it see, and what has it
 * read. It sits under /tokens on purpose: the token deny-list already keeps
 * every bearer token away from /tokens (F30.6), so no connection can read this
 * page's log or mint itself a sibling.
 */

import { html, when, type SafeHtml } from "../../http/html.ts";
import { formatDate } from "../../core/dates.ts";
import type { AiAccessRow } from "../../ai/access-log.ts";

export interface AiConnectionRow {
  id: string;
  name: string;
  redact: boolean;
  created_at: string;
  last_used_at: string | null;
  /** "Signed in from the app" (OAuth) or "Token". */
  how: string;
  /** Where its Disconnect button posts. */
  revoke_url: string;
}

export function renderConnectAi(opts: {
  mcpUrl: string;
  snapshotUrl: string;
  connections: AiConnectionRow[];
  log: AiAccessRow[];
  /** Present exactly once, straight after minting (F30.4). */
  minted?: { name: string; secret: string; redact: boolean } | null;
}): SafeHtml {
  const claudeCode = (secret: string) =>
    `claude mcp add --transport http pathayam ${opts.mcpUrl} --header "Authorization: Bearer ${secret}"`;
  // Gemini CLI's own syntax (google-gemini/gemini-cli docs/tools/mcp-server.md,
  // read 07-11-2026); -s user so it is not tied to whichever folder it ran in.
  const geminiCli = (secret: string) =>
    `gemini mcp add -s user --transport http --header "Authorization: Bearer ${secret}" pathayam ${opts.mcpUrl}`;
  const jsonConfig = (secret: string) => JSON.stringify({
    mcpServers: {
      pathayam: { type: "http", url: opts.mcpUrl, headers: { Authorization: `Bearer ${secret}` } },
    },
  }, null, 2);

  return html`
    <h1>Connect an AI</h1>
    <p class="muted">
      Let Claude, ChatGPT or another assistant read your budget and answer questions about it.
      A connection is <strong>read-only</strong>: it can look, never change anything. It sees what
      you see — the household budget and your own personal budget — and never another member's
      private accounts.
    </p>
    <p class="notice notice-warning">
      Whatever it reads is sent to that AI's provider and becomes part of the conversation there.
      Connect only the apps you would show these figures to.
    </p>

    ${when(opts.minted, () => html`
      <section class="card">
        <h2>"${opts.minted!.name}" is ready</h2>
        <p class="notice notice-warning">
          <strong>Copy it now.</strong> Only a hash of it is stored, so this is the last time it
          can be shown.
        </p>
        <p>Claude Code:</p>
        <pre class="raw-block" style="user-select:all;white-space:pre-wrap;word-break:break-all">${claudeCode(opts.minted!.secret)}</pre>
        <p>Gemini CLI:</p>
        <pre class="raw-block" style="user-select:all;white-space:pre-wrap;word-break:break-all">${geminiCli(opts.minted!.secret)}</pre>
        <p>Apps that take a JSON configuration (Claude Desktop, Cursor and others):</p>
        <pre class="raw-block" style="user-select:all;white-space:pre-wrap;word-break:break-all">${jsonConfig(opts.minted!.secret)}</pre>
        <p class="faint">
          ${opts.minted!.redact
            ? "Account numbers, UPI IDs, phone numbers and PAN are masked in what it is sent."
            : "Nothing is masked: it is sent names, narrations and numbers as they are."}
        </p>
      </section>
    `)}

    <section class="card">
      <h2>From claude.ai, the Claude apps, ChatGPT or Gemini</h2>
      <p>
        Add a custom connector (Gemini calls it a custom app) in the AI app and give it this
        address. Gemini CLI does the same with <code>gemini mcp add --transport http pathayam</code>
        and this address.
      </p>
      <pre class="raw-block" style="user-select:all">${opts.mcpUrl}</pre>
      <p class="faint">
        The app sends you back here to sign in and approve it. You choose there whether
        identifiers are masked. It then appears below, and you can disconnect it at any time.
      </p>
    </section>

    <section class="card">
      <h2>From Claude Code, Gemini CLI, Claude Desktop or a script</h2>
      <p class="faint">These take a token you paste into their configuration.</p>
      <form method="post" action="/tokens/ai">
        <div class="field">
          <label for="ai-name">Which app is it for?</label>
          <input id="ai-name" name="name" required maxlength="80" placeholder="Claude Code on my laptop">
        </div>
        <div class="field">
          <label><input type="checkbox" name="redact" value="1" checked>
            Mask account numbers, UPI IDs, phone numbers and PAN in what it is sent</label>
          <p class="faint">Best effort: a name written into a narration is not something a pattern can recognise.</p>
        </div>
        <div class="field">
          <label for="ai-expiry">Disconnect it after</label>
          <select id="ai-expiry" name="expires_in_days">
            <option value="30">30 days</option>
            <option value="90" selected>90 days</option>
            <option value="365">A year</option>
          </select>
        </div>
        <button class="button-primary" type="submit">Create a connection</button>
      </form>
    </section>

    <section class="card">
      <h2>Connected</h2>
      ${opts.connections.length === 0
        ? html`<p class="faint">Nothing is connected.</p>`
        : html`
          <div class="table-scroll">
            <table>
              <thead><tr>
                <th scope="col">App</th><th scope="col">How</th><th scope="col">Masked</th>
                <th scope="col">Connected</th><th scope="col">Last used</th><th scope="col"></th>
              </tr></thead>
              <tbody>
                ${opts.connections.map((c) => html`
                  <tr>
                    <td>${c.name}</td>
                    <td class="faint">${c.how}</td>
                    <td>${c.redact ? "Yes" : "No"}</td>
                    <td class="faint">${formatDate(c.created_at.slice(0, 10))}</td>
                    <td class="faint">${c.last_used_at ? formatDate(c.last_used_at.slice(0, 10)) : "Never"}</td>
                    <td>
                      <form method="post" action="${c.revoke_url}">
                        <button class="button-small button-danger" type="submit">Disconnect</button>
                      </form>
                    </td>
                  </tr>
                `)}
              </tbody>
            </table>
          </div>
        `}
    </section>

    <section class="card">
      <h2>What they have read</h2>
      <p class="faint">The question each connection asked, newest first. The answers are not kept.</p>
      ${opts.log.length === 0
        ? html`<p class="faint">Nothing yet.</p>`
        : html`
          <div class="table-scroll">
            <table>
              <thead><tr>
                <th scope="col">When</th><th scope="col">App</th><th scope="col">Asked for</th>
                <th scope="col">With</th><th scope="col">Result</th>
              </tr></thead>
              <tbody>
                ${opts.log.map((r) => html`
                  <tr>
                    <td class="faint">${formatDate(r.at.slice(0, 10))} ${r.at.slice(11, 16)}</td>
                    <td>${r.token_name}</td>
                    <td>${r.tool.replace(/_/g, " ")}</td>
                    <td class="faint" style="word-break:break-all">${r.arguments === "{}" ? "—" : r.arguments}</td>
                    <td>${r.ok ? `${Math.max(1, Math.round(r.bytes / 1024))} KB` : "Refused"}</td>
                  </tr>
                `)}
              </tbody>
            </table>
          </div>
        `}
    </section>

    <section class="card">
      <h2>Or paste a summary</h2>
      <p>
        <a href="${opts.snapshotUrl}">Download an analysis summary</a> (JSON): a year of budget,
        spending by envelope, accounts, loans, portfolio and tax, without the transaction list. It is
        meant for pasting into any AI chat or opening in a spreadsheet tool, when you would rather
        not connect anything.
      </p>
    </section>
  `;
}
