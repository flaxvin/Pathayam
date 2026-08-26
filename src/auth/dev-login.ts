/**
 * R38.1 · The development-only SSO bypass.
 *
 * **This file is deleted from the production image** (see `Dockerfile`), which
 * is what R38.5 requires: the bypass must not *exist* in a production
 * artefact, not merely be disabled in it. It is imported dynamically so that
 * removing it cannot break the build.
 *
 * The gate that stops it running anywhere production-shaped lives in
 * `config.ts` (`assertDevLoginSafe`), which refuses to start rather than
 * warning — a warning in a log is a bypass nobody reads (R38.3).
 *
 * It shares no code path with in-app impersonation (R38): that never bypasses
 * authentication, and always leaves a trail.
 */

import type { DB } from "../db/db.ts";
import { listMembers, createSession, type Member } from "./sessions.ts";
import { appendEvent } from "../core/events.ts";
import { html, type SafeHtml } from "../http/html.ts";

export const DEV_LOGIN_AVAILABLE = true;

export function developmentMembers(db: DB): Member[] {
  return listMembers(db);
}

export function signInAsDevelopmentMember(
  db: DB,
  memberId: string,
  opts: { userAgent?: string | null; ipHint?: string | null; days: number },
): { token: string } {
  const member = listMembers(db).find((m) => m.id === memberId);
  if (!member) throw new Error("That member does not exist.");

  const { token } = createSession(db, member.id, opts);

  // Logged like any other sign-in, and explicitly named as the bypass so it is
  // obvious in the trail that authentication was skipped.
  appendEvent(db, { memberId: member.id, source: "system" }, {
    entity: "session",
    entityId: member.id,
    action: "dev-login",
    summary: `Signed in as ${member.name} using the development bypass`,
  });

  return { token };
}

/** R38.1: select from a list of seeded members. */
export function renderDevLoginForm(members: Member[]): SafeHtml {
  return html`
    <div class="card">
      <h2>Development sign-in</h2>
      <p class="notice notice-warning">
        This bypasses authentication entirely and exists only on a development
        machine. It is not present in a production build.
      </p>
      ${members.length === 0
        ? html`<p class="muted">No members are seeded yet. Run <code>npm run seed</code> first.</p>`
        : html`
            <form method="post" action="/auth/dev" data-no-retry="true">
              <div class="field">
                <label for="dev-member">Sign in as</label>
                <select id="dev-member" name="member_id">
                  ${members.map((m) => html`<option value="${m.id}">${m.name} — ${m.email}</option>`)}
                </select>
              </div>
              <button class="button-primary" type="submit">Sign in</button>
            </form>
          `}
    </div>
  `;
}
