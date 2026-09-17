/**
 * Terms of service and privacy policy.
 *
 * These exist for one concrete reason: Google's OAuth consent screen requires a
 * homepage, a privacy policy URL and a terms URL before it will grant the
 * `gmail.readonly` scope, and `gmail.readonly` is a **restricted** scope, so the
 * policy has to carry the Limited Use disclosure verbatim or verification is
 * refused.
 *
 * Both pages are public (they are in `PUBLIC_PATHS`) because a reviewer fetches
 * them while signed out, and both are `bare` — no navigation chrome for someone
 * who is not a member of this household.
 *
 * Everything stated here is a fact about the code, not an intention:
 *
 *   · the Gmail query is built only from configured bank senders
 *     (`gmail/fetch.ts`), so nothing else is ever requested;
 *   · message bodies are parsed and dropped, never stored (`gmail/fetch.ts`);
 *   · the refresh token is excluded from exports and from the event log, and is
 *     never rendered to a screen (`gmail/connection.ts`, `ops/backup.ts`).
 *
 * If any of those change, this page is wrong and must change with them.
 */

import { html, type SafeHtml } from "../../http/html.ts";

/** The scopes actually requested, kept next to the prose that describes them. */
const SCOPES: { scope: string; what: string; why: string }[] = [
  {
    scope: "openid, email, profile",
    what: "Your Google account's email address, name and profile picture.",
    why: "To sign you in and show who made each change. Nothing else reads it.",
  },
  {
    scope: "https://www.googleapis.com/auth/gmail.readonly",
    what: "Read-only access to your Gmail messages.",
    why:
      "To find bank transaction alerts and statement PDFs, so they do not have " +
      "to be downloaded and uploaded by hand. The search is built only from the " +
      "bank senders you configure — no other message is ever requested.",
  },
];

function legalPage(title: string, updated: string, body: SafeHtml): SafeHtml {
  return html`
    <div class="prose-page">
      <p class="faint"><a href="/">← Budget</a></p>
      <h1>${title}</h1>
      <p class="faint">Last updated ${updated}</p>
      ${body}
      <hr>
      <p class="faint">
        Questions about either page go to whoever runs this installation. There
        is no company behind it and no support desk.
      </p>
      <p class="faint">
        <a href="/terms">Terms of service</a> · <a href="/privacy">Privacy policy</a>
      </p>
    </div>
  `;
}

export function renderPrivacy(opts: { appName: string; updated: string }): SafeHtml {
  return legalPage(
    "Privacy policy",
    opts.updated,
    html`
      <p>
        ${opts.appName} is a self-hosted budgeting application run by a single
        household on its own server. It is not a service offered to the public,
        there is no operating company, and there are no other users to share
        anything with.
      </p>

      <h2>The short version</h2>
      <ul>
        <li>Your data stays on the server you run. It is not sent anywhere else.</li>
        <li>There is no analytics, no advertising, no tracking and no profiling.</li>
        <li>Nothing is sold, rented or shared with any third party. Ever.</li>
        <li>No data is stored in your browser — no cookies beyond the one that keeps you signed in.</li>
      </ul>

      <h2>What Google data this app accesses</h2>
      <p>
        If you choose to sign in with Google, or to connect Gmail so bank emails
        can be read automatically, the app requests these scopes and no others:
      </p>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Scope</th>
              <th scope="col">What it grants</th>
              <th scope="col">Why this app asks</th>
            </tr>
          </thead>
          <tbody>
            ${SCOPES.map(
              (s) => html`
                <tr>
                  <td><code>${s.scope}</code></td>
                  <td>${s.what}</td>
                  <td>${s.why}</td>
                </tr>
              `,
            )}
          </tbody>
        </table>
      </div>

      <h2>How Gmail data is used, stored and shared</h2>
      <ul>
        <li>
          <strong>Used.</strong> The app searches your mailbox only for messages
          from the bank senders you have configured. It reads those messages to
          extract transaction details and to open statement PDFs.
        </li>
        <li>
          <strong>Stored.</strong> Message bodies are <em>not</em> retained. Each
          message is parsed into the fields that matter — date, amount, merchant,
          account — and then discarded. Only those extracted records are saved,
          in the same review queue as a statement you upload by hand.
        </li>
        <li>
          <strong>Shared.</strong> Never, with anyone, for any purpose. Gmail data
          is not transferred off the server, is not used to train any model, and
          is not used for advertising.
        </li>
        <li>
          <strong>Retained.</strong> The extracted records stay until you delete
          them. The Google refresh token is kept only so the connection survives a
          restart; it is excluded from every export and from the audit log, and is
          never displayed on any screen.
        </li>
      </ul>

      <h2>Limited Use</h2>
      <p>
        ${opts.appName}'s use and transfer of information received from Google
        APIs to any other app will adhere to the
        <a href="https://developers.google.com/terms/api-services-user-data-policy"
           rel="noopener noreferrer" target="_blank">Google API Services User Data Policy</a>,
        including the Limited Use requirements.
      </p>

      <h2>Other data the app holds</h2>
      <p>
        Everything you enter or import: accounts, transactions, budgets, goals,
        loans and investments, plus bank statements you upload and receipt images
        you attach. All of it lives in a single database file on your own server.
      </p>

      <h2>Revoking access and deleting data</h2>
      <ul>
        <li>
          Disconnect Gmail from <a href="/settings">Settings</a>. The stored
          refresh token is deleted immediately.
        </li>
        <li>
          Revoke the app entirely at
          <a href="https://myaccount.google.com/permissions"
             rel="noopener noreferrer" target="_blank">your Google account permissions page</a>.
        </li>
        <li>
          To delete everything, delete the database file. There is no copy
          anywhere else to ask anyone to remove.
        </li>
      </ul>

      <h2>Security</h2>
      <p>
        Data is held on the server you control, reachable only over your own
        network or tunnel. Sessions are cookie-based and revocable. Statement
        passwords and the Gmail token are held separately from exportable data
        precisely so an export cannot leak them.
      </p>

      <h2>Children</h2>
      <p>
        This is a household tool for the adults who run that household. It is not
        directed at children and collects nothing from them.
      </p>

      <h2>Changes</h2>
      <p>
        If this policy changes, the date at the top changes with it. Because the application is self-hosted, a change takes effect only on
        update.
      </p>
    `,
  );
}

export function renderTerms(opts: { appName: string; updated: string }): SafeHtml {
  return legalPage(
    "Terms of service",
    opts.updated,
    html`
      <p>
        ${opts.appName} is free, self-hosted software. These terms cover the
        person who installs and runs it, and anyone they invite into their
        household.
      </p>

      <h2>What you are agreeing to</h2>
      <ul>
        <li>
          You run this software on your own hardware, for your own household. You
          are responsible for the server, its backups and who can reach it.
        </li>
        <li>
          You will not use it to process anyone's financial data without their
          knowledge.
        </li>
        <li>
          You will connect only accounts and mailboxes you are entitled to
          access.
        </li>
      </ul>

      <h2>No warranty</h2>
      <p>
        The software is provided "as is", without warranty of any kind, express
        or implied, including the warranties of merchantability, fitness for a
        particular purpose and non-infringement. You run it at your own risk.
      </p>

      <h2>Not financial advice</h2>
      <p>
        Every figure this app shows — a projection, a runway, an interest saving,
        a portfolio return — is arithmetic on the numbers you gave it. None of it
        is financial, tax or investment advice, and none of it should be relied on
        as the sole basis for a decision. Check anything that matters against your
        bank, your statement and, where it counts, a qualified adviser.
      </p>

      <h2>Accuracy</h2>
      <p>
        Imported data can be wrong: a statement can be misread, a bank can change
        a format, a rule can miscategorise. The app puts imports into a review
        queue rather than straight into your ledger for that reason. Reconcile
        against your bank; the bank is the authority, not this app.
      </p>

      <h2>Limitation of liability</h2>
      <p>
        To the extent permitted by law, no author or contributor is liable for any
        damages — direct, indirect, incidental or consequential, including lost
        data or lost money — arising out of the use of or inability to use this
        software.
      </p>

      <h2>Your data</h2>
      <p>
        It is yours, it stays on your server, and you can export or delete it at
        any time. How it is handled is set out in the
        <a href="/privacy">privacy policy</a>.
      </p>

      <h2>Changes</h2>
      <p>
        These terms can change with a new version of the software. The date at the
        top says when they last did.
      </p>
    `,
  );
}
