/**
 * S5 · More hub · F5 payees · F6 rules editor · F3 categories · J1 first run.
 *
 * The rules editor doubles as a batch editor (F6.6) and can be tested against
 * history before saving (F6.7) — both because a rule the household cannot
 * predict is a rule they will not trust, and N9 forbids presenting a heuristic
 * as a fact.
 */

import { html, raw, when, type SafeHtml } from "../../http/html.ts";
import { formatPaise, type Paise } from "../../core/money.ts";
import { formatDate, type IsoDate } from "../../core/dates.ts";
import type { Rule, RuleStage, RuleSubject } from "../../import/rules.ts";

// ---------------------------------------------------------------------------
// S5 · The More hub
// ---------------------------------------------------------------------------

export function renderMore(features: { loans: boolean; assets: boolean }): SafeHtml {
  const group = (title: string, items: [string, string, string][]) => html`
    <section class="card">
      <h2>${title}</h2>
      ${items.map(
        ([href, label, blurb]) => html`
          <a href="${href}" style="display:block;padding:.6rem 0;border-top:1px solid var(--border);text-decoration:none;color:inherit">
            <strong style="color:var(--accent)">${label}</strong>
            <div class="faint">${blurb}</div>
          </a>
        `,
      )}
    </section>
  `;

  return html`
    <h1>More</h1>

    ${group("Understand", [
      ["/reports", "Reports", "Income against spending, and where it goes"],
      ["/query", "Query", "One table, filtered and grouped however you like"],
      ["/cards", "Cards", "Which one is due next, and is it funded"],
      ["/schedules", "Schedules & cashflow", "Will you make it to the 30th?"],
      ["/goals", "Goals", "Long-horizon savings, kept off the monthly grid"],
    ])}

    ${when(features.loans, () =>
      group("Debt", [
        ["/loans", "Loans", "What each one really costs, and what prepaying buys"],
        ["/loans/what-if", "Prepayment calculator", "Model it before committing a rupee"],
        ["/family", "Lending in the family", "Lent and borrowed, without interest maths"],
      ]),
    )}

    ${group("Keep it tidy", [
      ["/payees", "Payees", "Merge duplicates; every raw string is kept"],
      ["/rules", "Rules", "Automate categorisation, testable before you save"],
      ["/categories", "Categories", "Rename, reorder, hide"],
      ["/import", "Import", "Statements in, review queue out"],
      ["/activity", "Activity", "Every change, and the undo for it"],
    ])}

    ${group("Once a month", [
      ["/months", "Close the month", "What it did, and whether the next one is funded"],
    ])}

    ${group("Operate", [
      ["/health", "Health", "The page you open at 2am"],
      ["/settings", "Settings", "Household, appearance, devices"],
      ["/tokens", "API tokens", "For your own scripts, scoped and revocable"],
    ])}
  `;
}

// ---------------------------------------------------------------------------
// F5 · Payees
// ---------------------------------------------------------------------------

export interface PayeeRow {
  id: string;
  name: string;
  count: number;
  total: Paise;
  lastSeen: IsoDate | null;
  aliases: string[];
  usualCategory: string | null;
}

export function renderPayees(rows: PayeeRow[]): SafeHtml {
  return html`
    <h1>Payees</h1>
    <p class="muted">
      Every raw string the bank has ever used for a payee is kept, so a cleaned
      name never loses what it came from.
    </p>

    ${rows.length === 0
      ? html`<div class="card empty-state"><p>No payees yet.</p></div>`
      : html`
          <section class="card">
            ${rows.map(
              (p) => html`
                <div style="padding:.6rem 0;border-top:1px solid var(--border)">
                  <div class="row-between">
                    <div>
                      <strong>${p.name}</strong>
                      ${when(p.usualCategory, () => html`<span class="chip">${p.usualCategory}</span>`)}
                      <div class="faint">
                        ${p.count} transactions · ${formatPaise(Math.abs(p.total))} total
                        ${when(p.lastSeen, () => html` · last ${formatDate(p.lastSeen!)}`)}
                      </div>
                      ${when(p.aliases.length > 0, () => html`
                        <div class="faint" style="word-break:break-all">
                          Also seen as: ${p.aliases.slice(0, 3).join(" · ")}
                        </div>
                      `)}
                    </div>
                  </div>
                </div>
              `,
            )}
          </section>

          <section class="card">
            <h2>Merge two payees</h2>
            <p class="faint" style="margin-top:-.25rem">
              All history and every raw string move across. Nothing is lost, and it
              can be undone.
            </p>
            <form method="post" action="/payees/merge">
              <div class="grid-2">
                <div class="field">
                  <label for="loser">Merge this one…</label>
                  <select id="loser" name="loser_id" required>
                    ${rows.map((p) => html`<option value="${p.id}">${p.name}</option>`)}
                  </select>
                </div>
                <div class="field">
                  <label for="winner">…into this one</label>
                  <select id="winner" name="winner_id" required>
                    ${rows.map((p) => html`<option value="${p.id}">${p.name}</option>`)}
                  </select>
                </div>
              </div>
              <button type="submit">Merge</button>
            </form>
          </section>
        `}
  `;
}

// ---------------------------------------------------------------------------
// F6 · Rules
// ---------------------------------------------------------------------------

export interface RuleRow extends Rule {
  timesApplied: number;
  /** N9 · What the app inferred it from, for a proposal. Null for hand-written rules. */
  because?: string | null;
}

export function renderRules(opts: {
  rules: RuleRow[];
  proposed: RuleRow[];
  categories: { id: string; name: string }[];
  test?: {
    matched: number;
    samples: { before: RuleSubject; after: RuleSubject }[];
    categoryNames: Map<string, string>;
  } | null;
  draft?: { name: string; field: string; op: string; value: string; categoryId: string; stage: RuleStage } | null;
}): SafeHtml {
  return html`
    <h1>Rules</h1>
    <p class="muted">
      Rules propose; you confirm. Nothing here is applied to your ledger without
      passing through Review first, and a rule can be tried against your own
      history before you save it.
    </p>

    ${when(opts.proposed.length > 0, () => html`
      <section class="card">
        <h2>Proposed from what you've been doing <span class="chip">${opts.proposed.length}</span></h2>
        ${opts.proposed.map(
          (r) => html`
            <form method="post" action="/rules/confirm"
                  class="row-between" style="padding:.5rem 0;border-top:1px solid var(--border)">
              <input type="hidden" name="rule_id" value="${r.id}">
              <span>
                ${r.name}
                ${when(r.because, () => html`<div class="faint">${r.because}</div>`)}
              </span>
              <span class="row">
                <button class="button-small button-primary" type="submit">Use it</button>
                <button class="button-small" type="submit" formaction="/rules/dismiss">No thanks</button>
              </span>
            </form>
          `,
        )}
      </section>
    `)}

    <section class="card">
      <h2>Add a rule</h2>
      <form method="post" action="/rules/new">
        <div class="field">
          <label for="rule-name">Name it</label>
          <input id="rule-name" name="name" required
                 value="${opts.draft?.name ?? ""}" placeholder="Swiggy → Eating out">
        </div>

        <fieldset>
          <legend>When</legend>
          <div class="grid-2">
            <div class="field">
              <label for="cond-field">This</label>
              <select id="cond-field" name="field">
                ${[
                  ["merchant", "the merchant"],
                  ["narration", "the bank's whole description"],
                  ["vpa", "the UPI address"],
                  ["channel", "the channel (UPI, NEFT, ATM…)"],
                  ["importedPayee", "the imported payee"],
                  ["absoluteAmount", "the amount"],
                  ["cardLast4", "the card's last four digits"],
                ].map(
                  ([value, label]) => html`
                    <option value="${value}" ${raw(opts.draft?.field === value ? "selected" : "")}>
                      ${label}
                    </option>
                  `,
                )}
              </select>
            </div>
            <div class="field">
              <label for="cond-op">…does this</label>
              <select id="cond-op" name="op">
                ${[
                  ["contains", "contains"], ["is", "is exactly"],
                  ["startsWith", "starts with"], ["matches", "matches a pattern"],
                  ["greaterThan", "is more than"], ["lessThan", "is less than"],
                ].map(
                  ([value, label]) => html`
                    <option value="${value}" ${raw(opts.draft?.op === value ? "selected" : "")}>${label}</option>
                  `,
                )}
              </select>
            </div>
          </div>
          <div class="field">
            <label for="cond-value">…this</label>
            <input id="cond-value" name="value" required value="${opts.draft?.value ?? ""}" placeholder="Swiggy">
            <p class="field-hint">
              Matching on the merchant rather than the whole description keeps the rule
              working when the order number changes — which it does every time.
            </p>
          </div>
        </fieldset>

        <fieldset>
          <legend>Then</legend>
          <div class="field">
            <label for="action-category">Put it in</label>
            <select id="action-category" name="category_id" required>
              ${opts.categories.map(
                (c) => html`
                  <option value="${c.id}" ${raw(opts.draft?.categoryId === c.id ? "selected" : "")}>
                    ${c.name}
                  </option>
                `,
              )}
            </select>
          </div>
        </fieldset>

        <!-- F6.7: try it against history before saving, with before/after. -->
        <button type="submit" formaction="/rules/test">Try it on my history</button>
        <button class="button-primary" type="submit">Save the rule</button>
      </form>

      ${when(opts.test, () => renderRuleTest(opts.test!))}
    </section>

    <section class="card">
      <h2>Your rules</h2>
      ${opts.rules.length === 0
        ? html`<p class="faint">None yet.</p>`
        : html`
            <p class="faint" style="margin-top:-.25rem">
              Rules run in three stages — clean up, then categorise, then tag — and
              within a stage the broad ones run before the narrow ones. You never
              have to order them yourself.
            </p>
            ${opts.rules.map(
              (r) => html`
                <div class="row-between" style="padding:.5rem 0;border-top:1px solid var(--border)">
                  <div>
                    <strong>${r.name}</strong>
                    <span class="chip">${r.stage}</span>
                    <div class="faint">
                      ${r.conditions.map((c) => `${c.field} ${c.op} ${String(c.value)}`).join(", ")}
                      · applied ${r.timesApplied} times
                    </div>
                  </div>
                  <span class="row">
                    <!-- F6.6: the rule editor doubles as a batch editor. -->
                    <form method="post" action="/rules/${r.id}/apply">
                      <button class="button-small" type="submit">Apply to existing</button>
                    </form>
                    <form method="post" action="/rules/${r.id}/delete">
                      <button class="button-small button-danger" type="submit">Remove</button>
                    </form>
                  </span>
                </div>
              `,
            )}
          `}
    </section>
  `;
}

/** F6.7 · A match count and a before/after preview, before anything is saved. */
function renderRuleTest(test: {
  matched: number;
  samples: { before: RuleSubject; after: RuleSubject }[];
  categoryNames: Map<string, string>;
}): SafeHtml {
  return html`
    <div class="notice ${test.matched > 0 ? "notice-success" : "notice-warning"}" style="margin-top:1rem">
      ${test.matched === 0
        ? html`That rule matches nothing in your history. It will still apply to
               anything new that fits — but check the wording first.`
        : html`Matches <strong>${test.matched}</strong> ${test.matched === 1 ? "transaction" : "transactions"}
               in your history.`}
    </div>

    ${when(test.samples.length > 0, () => html`
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">What the bank sent</th>
              <th scope="col">Now</th>
              <th scope="col">Would become</th>
            </tr>
          </thead>
          <tbody>
            ${test.samples.map(
              (s) => html`
                <tr>
                  <td class="faint" style="word-break:break-all">${s.before.narration}</td>
                  <td>${s.before.categoryId ? test.categoryNames.get(s.before.categoryId) ?? "—" : "—"}</td>
                  <td>
                    <strong>
                      ${s.after.categoryId ? test.categoryNames.get(s.after.categoryId) ?? "—" : "—"}
                    </strong>
                  </td>
                </tr>
              `,
            )}
          </tbody>
        </table>
      </div>
    `)}
  `;
}

// ---------------------------------------------------------------------------
// F3 · Categories
// ---------------------------------------------------------------------------

export function renderCategories(
  groups: {
    id: string;
    name: string;
    kind: string;
    categories: {
      id: string; name: string; hidden: boolean; balance: Paise; isPayment: boolean;
      target: { amount: Paise; date: string | null } | null;
    }[];
  }[],
  /** 15 · Whose grid this is, so the heading says which money is being shaped. */
  budget?: { id: string; name: string; kind: string },
): SafeHtml {
  // F3.6 · Up/down nudges. Reordering is positional, so it is offered on every
  // row and group — including app-managed ones, which carry no other controls.
  const reorder = (action: string, isFirst: boolean, isLast: boolean) => html`
    <span class="row" style="gap:.2rem">
      <form method="post" action="${action}">
        <input type="hidden" name="direction" value="up">
        <button class="button-small button-quiet" type="submit" aria-label="Move up"
                title="Move up" ${raw(isFirst ? "disabled" : "")}>↑</button>
      </form>
      <form method="post" action="${action}">
        <input type="hidden" name="direction" value="down">
        <button class="button-small button-quiet" type="submit" aria-label="Move down"
                title="Move down" ${raw(isLast ? "disabled" : "")}>↓</button>
      </form>
    </span>
  `;

  const isPersonal = budget?.kind === "personal";

  return html`
    <h1>Categories</h1>
    <p class="muted">
      Rename, set a target (what a category should hold), reorder, hide, or delete.
      A target drives the underfunded figure and one-tap auto-assign.
      ${when(Boolean(budget), () => html`
        These are the envelopes in
        ${isPersonal ? html`<strong>${budget!.name}'s budget</strong>` : html`<strong>the household budget</strong>`}.
      `)}
    </p>

    ${when(groups.length === 0, () => html`
      <section class="card">
        <h2>Nothing here yet</h2>
        <p class="muted">
          This budget has no envelopes. Start a group below — <em>Mine</em> or
          <em>Spending</em> does the job — and add envelopes to it.
        </p>
      </section>
    `)}

    ${groups.map(
      (g, gi) => html`
        <section class="card">
          <div class="row-between">
            <h2>${g.name}</h2>
            <span class="row" style="gap:.5rem">
              ${when(g.kind !== "normal", () => html`<span class="chip">managed by the app</span>`)}
              ${reorder(`/groups/${g.id}/reorder`, gi === 0, gi === groups.length - 1)}
            </span>
          </div>
          ${g.categories.map(
            (c, ci) => {
              // B58: a payment category, and any category in an app-managed
              // group (a goal's savings envelope), carries no manual controls.
              const managed = c.isPayment || g.kind !== "normal";
              return html`
              <div style="padding:.6rem 0;border-top:1px solid var(--border)">
                <div class="row-between">
                  <form method="post" action="/categories/${c.id}/rename" class="row" style="flex:1;gap:.4rem">
                    <input name="name" value="${c.name}" style="max-width:18rem"
                           ${raw(managed ? "readonly" : "")}>
                    ${when(!managed, () => html`<button class="button-small" type="submit">Rename</button>`)}
                  </form>
                  ${reorder(`/categories/${c.id}/reorder`, ci === 0, ci === g.categories.length - 1)}
                  <span class="amount">${formatPaise(c.balance)}</span>
                </div>
                ${when(!managed, () => html`
                  <div class="row" style="gap:.6rem;flex-wrap:wrap;margin-top:.4rem;align-items:flex-end">
                    <form method="post" action="/categories/${c.id}/target" class="row" style="gap:.4rem;align-items:flex-end">
                      <div class="field" style="margin:0">
                        <label style="font-size:.75rem" for="tgt-${c.id}">Monthly target</label>
                        <input id="tgt-${c.id}" name="amount" class="amount-input" style="max-width:8rem"
                               type="text" inputmode="decimal" placeholder="none"
                               value="${c.target ? (c.target.amount / 100).toFixed(2) : ""}">
                      </div>
                      <div class="field" style="margin:0">
                        <label style="font-size:.75rem" for="tgtd-${c.id}">By date (optional)</label>
                        <input type="date" id="tgtd-${c.id}" name="target_date" style="max-width:8rem" value="${c.target?.date ?? ''}">
                      </div>
                      <button class="button-small" type="submit">Set target</button>
                    </form>
                    <form method="post" action="/categories/${c.id}/hide">
                      <input type="hidden" name="hidden" value="${c.hidden ? "0" : "1"}">
                      <button class="button-small button-quiet" type="submit">${c.hidden ? "Unhide" : "Hide"}</button>
                    </form>
                    <form method="post" action="/categories/${c.id}/delete"
                          onsubmit="return confirm('Delete this category? It must be empty; its money is unaffected.')">
                      <button class="button-small button-danger" type="submit"
                              ${raw(c.balance !== 0 ? "disabled title=\"Move its balance out first\"" : "")}>Delete</button>
                    </form>
                  </div>
                `)}
              </div>
            `;
            },
          )}
        </section>
      `,
    )}

    <section class="card">
      <h2>Add a group</h2>
      <p class="muted">
        A group is a heading the envelopes sit under. It belongs to this budget
        and does not appear in the other one.
      </p>
      <form method="post" action="/groups/new" class="row" style="gap:.5rem;align-items:flex-end">
        <div class="field" style="margin:0">
          <label for="grp-name">Name</label>
          <input id="grp-name" name="name" required placeholder="Spending">
        </div>
        <button type="submit">Add group</button>
      </form>
    </section>

    <section class="card">
      <h2>Add a category</h2>
      <form method="post" action="/categories/new">
        <div class="grid-2">
          <div class="field">
            <label for="cat-name">Name</label>
            <input id="cat-name" name="name" required>
          </div>
          <div class="field">
            <label for="cat-group">In</label>
            <select id="cat-group" name="group_id" required>
              ${groups
                .filter((g) => g.kind === "normal")
                .map((g) => html`<option value="${g.id}">${g.name}</option>`)}
            </select>
          </div>
        </div>
        <button type="submit">Add category</button>
      </form>
    </section>
  `;
}

// ---------------------------------------------------------------------------
// J1 · First run
// ---------------------------------------------------------------------------

/**
 * `02` §8: "The empty state is where budgeting apps lose people."
 *
 * Five questions, a generated budget, one account, and the moment that matters
 * — Ready to Assign becoming a real number. Skippable at every step (J1).
 */
export function renderFirstRun(opts: { memberName: string }): SafeHtml {
  return html`
    <div style="max-width:34rem;margin:2rem auto">
      <h1>Let's get you a working budget</h1>
      <p class="muted">
        Under ten minutes. Everything here is a starting point you'll edit —
        nothing is locked in.
      </p>

      <form method="post" action="/setup" class="card">
        <div class="field">
          <label for="income">Roughly what lands each month, after tax?</label>
          <input id="income" name="monthly_income" class="amount-input" type="text"
                 inputmode="decimal" required placeholder="1,65,000">
          <p class="field-hint">
            Used only to suggest starting amounts. It is never treated as income
            you have — this app only budgets money you actually hold.
          </p>
        </div>

        <fieldset>
          <legend>So we can leave out what doesn't apply</legend>
          <div class="field">
            <label><input type="checkbox" name="has_emis" value="1" checked> I have EMIs or loan repayments</label>
          </div>
          <div class="field">
            <label><input type="checkbox" name="has_school_fees" value="1"> I pay school or college fees</label>
          </div>
          <div class="field">
            <label><input type="checkbox" name="has_domestic_help" value="1" checked> I pay domestic help</label>
          </div>
        </fieldset>

        <button class="button-primary" type="submit">Build my starting budget</button>
      </form>

      <div class="card">
        <h2>Rather start empty?</h2>
        <p class="muted">
          You'll get one group and nothing else, and can build it up yourself.
        </p>
        <form method="post" action="/setup/blank">
          <button type="submit">Start blank instead</button>
        </form>
      </div>

      <p class="faint">
        Signed in as ${opts.memberName}. You can add the rest of the household
        from Settings once you're set up.
      </p>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// `08` F30 · Personal API tokens
// ---------------------------------------------------------------------------

export interface TokenRow {
  id: string;
  name: string;
  scope: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
}

export function renderTokens(opts: {
  tokens: TokenRow[];
  /** F30.4 · Present exactly once, immediately after minting. */
  minted?: { name: string; secret: string } | null;
}): SafeHtml {
  return html`
    <h1>API tokens</h1>
    <p class="muted">
      For your own scripts. A token acts as you, but it cannot sign in,
      impersonate anyone, create more tokens, or change who is allowed into the
      household — no matter what you do with it.
    </p>

    ${when(opts.minted, () => html`
      <section class="card">
        <h2>Here is "${opts.minted!.name}"</h2>
        <p class="notice notice-warning">
          <strong>Copy it now.</strong> Only a hash of it is stored, so this is
          the last time it can be shown — not a policy, a fact about the
          database.
        </p>
        <pre class="raw-block" style="user-select:all">${opts.minted!.secret}</pre>
      </section>
    `)}

    ${opts.tokens.length === 0
      ? html`<div class="card empty-state"><p>No tokens yet.</p></div>`
      : html`
          <section class="card">
            <table>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Scope</th>
                  <th scope="col">Created</th>
                  <th scope="col">Last used</th>
                  <th scope="col"></th>
                </tr>
              </thead>
              <tbody>
                ${opts.tokens.map(
                  (t) => html`
                    <tr>
                      <td>${t.name}</td>
                      <td>${t.scope === "read" ? "Read only" : "Read and write"}</td>
                      <td class="faint">${t.created_at.slice(0, 10)}</td>
                      <td class="faint">${t.last_used_at?.slice(0, 10) ?? "Never"}</td>
                      <td>
                        <form method="post" action="/tokens/${t.id}/revoke">
                          <button class="button-small button-danger" type="submit">Revoke</button>
                        </form>
                      </td>
                    </tr>
                  `,
                )}
              </tbody>
            </table>
          </section>
        `}

    <section class="card">
      <h2>Mint a token</h2>
      <form method="post" action="/tokens">
        <div class="field">
          <label for="token-name">What is it for?</label>
          <input id="token-name" name="name" required placeholder="Laptop export script">
        </div>
        <div class="field">
          <label for="token-scope">What may it do?</label>
          <select id="token-scope" name="scope">
            <option value="read">Read only</option>
            <option value="read-write">Read and write</option>
          </select>
        </div>
        <div class="field">
          <label for="token-expiry">Expire it after</label>
          <select id="token-expiry" name="expires_in_days">
            <option value="90">90 days</option>
            <option value="365">A year</option>
            <option value="">Never</option>
          </select>
        </div>
        <button class="button-primary" type="submit">Mint it</button>
      </form>
    </section>
  `;
}
