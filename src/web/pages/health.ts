/**
 * S15 · Health & status.
 *
 * `08` §10: "This is the page you open at 2am; it must be legible then."
 *
 * F27.4 is the rule that shapes it: every check has an explicit
 * healthy/degraded/failed state **with a plain-language reason** — never a
 * bare boolean.
 */

import { html, when, type SafeHtml } from "../../http/html.ts";
import { formatDate } from "../../core/dates.ts";

export type CheckState = "healthy" | "degraded" | "failed" | "unknown";

export interface Check {
  name: string;
  state: CheckState;
  /** F27.4: why it is in that state, in words. */
  reason: string;
  lastRun?: string | null;
  /** Where a "run now" control makes sense (F26.8). */
  action?: { label: string; href: string } | null;
}

export interface HealthGroup {
  name: string;
  checks: Check[];
}

const CHIP: Record<CheckState, string> = {
  healthy: "chip-positive",
  degraded: "chip-warning",
  failed: "chip-danger",
  unknown: "",
};

const LABEL: Record<CheckState, string> = {
  healthy: "OK",
  degraded: "Needs attention",
  failed: "Failed",
  unknown: "Not run yet",
};

export function overallState(groups: HealthGroup[]): CheckState {
  const states = groups.flatMap((g) => g.checks.map((c) => c.state));
  if (states.includes("failed")) return "failed";
  if (states.includes("degraded")) return "degraded";
  if (states.includes("unknown")) return "degraded";
  return "healthy";
}

export function renderHealth(groups: HealthGroup[]): SafeHtml {
  const overall = overallState(groups);

  return html`
    <div class="row-between" style="margin-bottom:1rem">
      <h1>Health</h1>
      <span class="chip ${CHIP[overall]}" style="font-size:1rem">
        ${overall === "healthy" ? "Everything is fine" : LABEL[overall]}
      </span>
    </div>

    ${groups.map(
      (group) => html`
        <section class="card">
          <h2>${group.name}</h2>
          ${group.checks.map(
            (check) => html`
              <div class="row-between" style="padding:.6rem 0;border-top:1px solid var(--border);align-items:flex-start">
                <div style="flex:1;min-width:0">
                  <strong>${check.name}</strong>
                  <div class="faint">${check.reason}</div>
                  ${when(check.lastRun, () => html`
                    <div class="faint">Last run ${formatDate(check.lastRun!.slice(0, 10))}</div>
                  `)}
                </div>
                <div class="row">
                  <span class="chip ${CHIP[check.state]}">${LABEL[check.state]}</span>
                  ${when(check.action, () => html`
                    <form method="post" action="${check.action!.href}">
                      <button class="button-small" type="submit">${check.action!.label}</button>
                    </form>
                  `)}
                </div>
              </div>
            `,
          )}
        </section>
      `,
    )}

    <section class="card">
      <h2>Data</h2>
      <p class="muted">
        Everything here is exportable in one action, in an open format that does not
        need this app to read it.
      </p>
      <div class="row" style="flex-wrap:wrap">
        <a class="button" href="/export.json">Export everything (JSON)</a>
        <a class="button" href="/export.csv">Export transactions (CSV)</a>
      </div>
    </section>
  `;
}
