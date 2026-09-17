/**
 * Terms of service and privacy policy, as served by the application itself.
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
 * ## Two deployments, two different sets of true statements
 *
 * The same binary runs as somebody's private household server and as the public
 * demo, and almost nothing about responsibility is true of both. "There is no
 * company behind it and no support desk" is exactly right on a self-hosted
 * install and a falsehood on demo.pathayam.app, which Flaxvin Technologies
 * operates. So the pages take a `mode` and state what is true of the deployment
 * actually serving them, rather than averaging the two into something wrong for
 * each.
 *
 * `website/privacy.html` and `website/terms.html` are the public, canonical
 * pages and cover the same ground for the site, the demo and the hosted service.
 * These are deliberately their sibling and not their copy: a self-hosted install
 * must be able to answer "what happens to my data" without reaching for
 * pathayam.app, and it needs a different answer. **When the substance changes on
 * one side, it changes on both.**
 *
 * Everything stated here is a fact about the code, not an intention:
 *
 *   · the Gmail query is built only from configured bank senders
 *     (`gmail/fetch.ts`), so nothing else is ever requested;
 *   · message bodies are parsed and dropped, never stored (`gmail/fetch.ts`);
 *   · the refresh token is excluded from exports and from the event log, and is
 *     never rendered to a screen (`gmail/connection.ts`, `ops/backup.ts`);
 *   · the request log records method, path, status and duration and never a
 *     query string, a form body or an amount (`http/server.ts`).
 *
 * If any of those change, this page is wrong and must change with them.
 */

import { html, type SafeHtml } from "../../http/html.ts";

/**
 * Which deployment is serving the page. `demo` is the public instance anyone
 * can walk into; `self-hosted` is the default and covers everybody running
 * their own copy.
 */
export type LegalMode = "self-hosted" | "demo";

/** The operator of the public instances, named because somebody is responsible. */
const OPERATOR = "Flaxvin Technologies";
const OPERATOR_SITE = "https://flaxvin.tech";
const PRIVACY_EMAIL = "privacy@pathayam.app";
const SUPPORT_EMAIL = "support@pathayam.app";
const LICENCE_EMAIL = "hello@flaxvin.tech";

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

function legalPage(
  title: string,
  updated: string,
  mode: LegalMode,
  body: SafeHtml,
): SafeHtml {
  return html`
    <div class="prose-page">
      <p class="faint"><a href="/">← Budget</a></p>
      <h1>${title}</h1>
      <p class="faint">
        Last updated ${updated} ·
        ${mode === "demo"
          ? html`Applies to this public demo.`
          : html`Applies to this installation.`}
      </p>
      ${body}
      <hr>
      ${mode === "demo"
        ? html`
            <p class="faint">
              This is the copy the demo serves. The canonical pages, which also
              cover the website and the hosted service, are at
              <strong>pathayam.app/privacy</strong> and
              <strong>pathayam.app/terms</strong>.
            </p>
          `
        : html`
            <p class="faint">
              Questions about either of these pages go to the person who runs
              this installation. ${OPERATOR} publishes the software but operates
              nothing here, holds none of this data and cannot reach it.
            </p>
          `}
      <p class="faint">
        <a href="/terms">Terms of service</a> · <a href="/privacy">Privacy policy</a>
      </p>
    </div>
  `;
}

export function renderPrivacy(
  opts: { appName: string; updated: string; mode?: LegalMode },
): SafeHtml {
  const mode = opts.mode ?? "self-hosted";
  const demo = mode === "demo";

  return legalPage(
    "Privacy policy",
    opts.updated,
    mode,
    html`
      ${demo
        ? html`
            <p>
              This is the public demo of ${opts.appName}, operated by ${OPERATOR}
              (<a href="${OPERATOR_SITE}" rel="noopener noreferrer" target="_blank">flaxvin.tech</a>).
              For the purposes of the Digital Personal Data Protection Act, 2023,
              ${OPERATOR} is the Data Fiduciary for anything described below.
              Questions, requests and complaints:
              <a href="mailto:${PRIVACY_EMAIL}">${PRIVACY_EMAIL}</a>.
            </p>

            <h2>Do not put anything real into this demo</h2>
            <p>
              This instance is shared and public. It is filled with invented
              data, it resets when it restarts, and anything you type is visible
              to every other visitor until then. Do not enter a real account
              number, a real balance, a real PAN, or any other real personal or
              financial information.
            </p>
            <p>
              Entering the demo sets one session cookie, so the app knows which
              invented member you are looking as. It is strictly necessary for
              the demo to work, expires with the session, and is not used for
              analytics. There is no other cookie and no tracking of any kind.
            </p>
          `
        : html`
            <p>
              ${opts.appName} is self-hosted software, run here by one household
              on its own server. This policy covers that installation, and the
              person who runs it is responsible for it. ${OPERATOR} publishes the
              software and operates nothing here: it makes no outbound request to
              us, sends no telemetry and reports no errors.
            </p>

            <h2>The short version</h2>
            <ul>
              <li>Your data stays on the server you run. It is not sent anywhere else.</li>
              <li>There is no analytics, no advertising, no tracking and no profiling.</li>
              <li>Nothing is sold, rented or shared with any third party. Ever.</li>
              <li>No cookie beyond the one that keeps you signed in.</li>
            </ul>
          `}

      <h2>What this app holds</h2>
      <ul>
        <li>
          <strong>Account identity.</strong> The email address, name and profile
          picture on the Google account used to sign in — to sign you in, and to
          attribute each change to a person.
        </li>
        <li>
          <strong>Household financial data.</strong> Everything entered or
          imported: accounts, balances, transactions, payees, envelopes, loans,
          holdings, and attachments such as receipts.
        </li>
        <li>
          <strong>Statement identity.</strong> Optional. A name, date of birth,
          PAN, mobile or card last-four, used to derive the password a bank sets
          on a statement PDF, so a statement opens without it being typed every
          month.
        </li>
        <li>
          <strong>Operational logs.</strong> Method, path, status, duration and
          errors. Never query strings, form bodies, amounts or any financial
          value.
        </li>
      </ul>

      <h2>Statement identity is never exported or logged</h2>
      <p>
        The details used to derive statement passwords are held apart from
        everything exportable. They are excluded from every export, from the
        audit log and from backups of the exportable data, and are never rendered
        to any screen. This is deliberate, so that handing someone an export can
        never hand them a PAN.
      </p>

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
          <strong>Used.</strong> The app searches the mailbox only for messages
          from the bank senders that have been configured. It reads those
          messages to extract transaction details and to open statement PDFs.
        </li>
        <li>
          <strong>Stored.</strong> Message bodies are <em>not</em> retained. Each
          message is parsed into the fields that matter — date, amount, merchant,
          account — and then discarded. Only those extracted records are saved,
          in the same review queue as a statement uploaded by hand.
        </li>
        <li>
          <strong>Shared.</strong> Never, with anyone, for any purpose. Gmail data
          is not used to train any model and is not used for advertising.
        </li>
        <li>
          <strong>Retained.</strong> The extracted records stay until deleted. The
          Google refresh token is kept only so the connection survives a restart;
          it is excluded from every export and from the audit log, and is never
          displayed on any screen.
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

      <h2>Your rights</h2>
      <ul>
        <li>
          <strong>Get a copy.</strong> One endpoint returns everything in an open
          format, at any time.
        </li>
        <li><strong>Correct it.</strong> Every figure in the app is editable directly.</li>
        <li>
          <strong>Erase it.</strong>
          ${demo
            ? html`Everything here is invented and goes at the next reset regardless.`
            : html`Delete the database file. There is no copy anywhere else to ask
                   anyone to remove.`}
        </li>
        ${demo
          ? html`
              <li>
                <strong>Complain.</strong> To
                <a href="mailto:${PRIVACY_EMAIL}">${PRIVACY_EMAIL}</a> first, and
                then to the Data Protection Board of India if it is not resolved.
                Grievances reach the same address and are answered within 30 days.
              </li>
            `
          : html``}
      </ul>

      <h2>Revoking Google access</h2>
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
      </ul>

      <h2>Security</h2>
      <p>
        Sign-in is Google OAuth with PKCE and no password is stored. Session
        tokens are held as hashes. Writes require a same-origin check. API tokens
        are scoped, revocable, stored hashed, and cannot reach token management or
        member administration. Statement passwords and the Gmail token are held
        separately from exportable data precisely so an export cannot leak them.
      </p>
      <p>
        ${demo
          ? html`
              Traffic is served over HTTPS. The database is not encrypted at rest
              beyond the disk encryption the hosting provider applies — which is
              why the demo contains nothing but invented data.
            `
          : html`
              The database is a file on the server you control, reachable only
              over your own network or tunnel, and is not encrypted at rest beyond
              whatever that machine applies. Anyone with the file has its
              contents.
            `}
      </p>

      <h2>Children</h2>
      <p>
        ${demo
          ? html`This demo is not offered to anyone under 18.`
          : html`
              This is a household tool for the adults who run that household. It
              is not directed at children and collects nothing from them.
            `}
      </p>

      <h2>Changes</h2>
      <p>
        If this policy changes, the date at the top changes with it.
        ${demo
          ? html``
          : html`
              Because the app is self-hosted, a change reaches you only when you
              update the app.
            `}
      </p>
    `,
  );
}

export function renderTerms(
  opts: { appName: string; updated: string; mode?: LegalMode },
): SafeHtml {
  const mode = opts.mode ?? "self-hosted";
  const demo = mode === "demo";

  return legalPage(
    "Terms of service",
    opts.updated,
    mode,
    html`
      ${demo
        ? html`
            <p>
              These terms are between you and ${OPERATOR}
              (<a href="${OPERATOR_SITE}" rel="noopener noreferrer" target="_blank">flaxvin.tech</a>).
              Using this demo means you accept them.
            </p>

            <h2>This demo</h2>
            <p>
              It is shared and public. It is filled with invented data, it resets
              when it restarts, and anything you enter is visible to other
              visitors and destroyed at the next reset. It carries no
              confidentiality and no availability promise, and may be changed or
              withdrawn at any time. Do not enter real financial or personal
              information into it.
            </p>
          `
        : html`
            <p>
              ${opts.appName} is self-hosted software. These terms cover the
              person who installs and runs it, and anyone they invite into their
              household. This installation is yours entirely: ${OPERATOR}
              provides no service with it, holds none of its data, and makes no
              promises about it beyond the licence's disclaimer.
            </p>
          `}

      <h2>The software itself</h2>
      <p>
        ${opts.appName} is released under the PolyForm Noncommercial License
        1.0.0. That licence, not this page, governs what may be done with the
        code. In outline, and the licence text prevails where they differ: run it,
        change it and share it for any noncommercial purpose — a household,
        personal study, research, a hobby, a charity, a school. Commercial use is
        not permitted, including running it inside a business or using it for the
        books of a company or a freelance practice. Commercial licences are
        available separately: <a href="mailto:${LICENCE_EMAIL}">${LICENCE_EMAIL}</a>.
      </p>

      <h2>Acceptable use</h2>
      <ul>
        <li>Do not use it to break the law, or to hold data you have no right to hold.</li>
        <li>
          Do not process anyone's financial data without their knowledge, and
          connect only accounts and mailboxes you are entitled to access.
        </li>
        ${demo
          ? html`
              <li>
                Do not probe, scan or overload this demo, or automate against it
                in a way that degrades it for others.
              </li>
            `
          : html`
              <li>
                You are responsible for the server, its backups and who can reach
                it.
              </li>
            `}
      </ul>

      <h2>Not financial advice</h2>
      <p>
        Every figure this app shows — a projection, a runway, an interest saving,
        a portfolio return — is arithmetic on the numbers it was given. None of it
        is financial, tax or investment advice, and none of it should be relied on
        as the sole basis for a decision. Check anything that matters against your
        bank, your statement and, where it counts, a qualified adviser.
      </p>

      <h2>Accuracy</h2>
      <p>
        Imported data can be wrong: a statement can be misread, a bank can change
        a format, a rule can miscategorise. The app puts imports into a review
        queue rather than straight into the ledger for that reason. Reconcile
        against your bank; the bank is the authority, not this app.
      </p>

      <h2>No warranty</h2>
      <p>
        The software is provided "as is", without warranty of any kind, express
        or implied, including the warranties of merchantability, fitness for a
        particular purpose and non-infringement. You run it at your own risk.
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
        ${demo
          ? html`
              Nothing in this demo is yours or anyone's: it is invented, shared
              and disposable. Do not rely on anything typed here surviving.
            `
          : html`
              It is yours, it stays on your server, and you can export or delete
              it at any time. One endpoint returns everything in an open format.
              How it is handled is set out in the
              <a href="/privacy">privacy policy</a>.
            `}
      </p>

      ${demo
        ? html`
            <h2>Governing law</h2>
            <p>
              These terms are governed by the laws of India. The courts at Kochi,
              Kerala have exclusive jurisdiction, save that either party may seek
              urgent injunctive relief anywhere.
            </p>

            <h2>Contact</h2>
            <p>
              <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> for the
              service, <a href="mailto:${PRIVACY_EMAIL}">${PRIVACY_EMAIL}</a> for
              anything about data.
            </p>
          `
        : html``}

      <h2>Changes</h2>
      <p>
        These terms can change with a new version of the software. The date at the
        top says when they last did.
      </p>
    `,
  );
}
