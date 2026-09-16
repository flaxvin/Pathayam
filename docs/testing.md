# Testing

1,119 tests in 92 files, using `node:test`. No test framework, no mocking
library, no fixture database.

```bash
npm test                                              # everything
npm run typecheck                                     # tsc --noEmit
node --experimental-strip-types --test src/engine/engine.test.ts
npm test -- --test-name-pattern="identity"
```

Tests build their own databases in memory via `freshDb()` and drive the HTTP
surface through `startTestApp()`, which starts the real application on an
ephemeral port.

## Verification by invariant

Three properties can be checked without anybody asserting an expected value.

### The accounting identity

```
Σ budget-account balances  +  due from other budgets
    =  Σ category balances  +  Ready to Assign  +  held for next month
       +  Σ future assignments  −  unfunded credit absorbed
```

`identityResidual(state)` must be `0` for every month in every budget. The
top-down simulation asserts it after each month as history is built, so a
failure identifies the month in which it began.

### Cache against ledger

Every month is computed twice — `useRollup: true` and `useRollup: false` — and
the results compared. Ready to Assign and every envelope balance must agree.

### Statement reconciliation

Where a bank statement prints both an opening and a closing balance,
`opening + Σ parsed amounts − closing` must be zero. This validates the PDF
parser against a figure it did not derive.

## The top-down simulation

`src/sim/scenario.ts` simulates a household of four over 36 months:

- four members, one household budget and two personal budgets;
- salaries, rent, groceries, utilities, cards, transfers, cash;
- quarterly CSV statement imports producing real duplicates in the review queue;
- loans taken, paid, rate-changed, prepaid and closed; an EMI conversion;
- a portfolio with purchases, a sale, a dividend, a split, a merger, a return of
  capital, and hand-valued accounts including one in a foreign currency;
- goals, schedules, tags, splits, attachments, reconciliations, month closes;
- rules proposed at month 12, confirmed, and applied to later imports;
- two members removed at month 24; one restored at month 30.

`SCENARIO_MONTHS = 36`, `DEPARTURE_AT = 23`, `RETURN_AT = 29`,
`SIGNED_IN_AS = "ravi"`.

The same function seeds the demo database, so the demo and the test subject are
the same artefact.

### What the scenario test asserts

| Assertion | Detail |
|---|---|
| Identity | Zero residual after every month in every budget. |
| Cache | Rollup and ledger agree for every month. |
| Coverage | Every exported mutating function in `src/domain/` and `src/import/` is called. The list is read from the source at test time. |
| Production | `rule_applications`, `transaction_splits` and `transaction_tags` are non-empty, and splits sum to their transactions. |
| Household shape | Removal preserves authorship; restoration finds the same member; the signed-in member is present at the end. |
| Multi-currency | A foreign-currency account is converted at the dated rate, and allocation shares sum to 1. |
| Second seed | The identity closes for a different generated household. |

## Structural tests

Tests that constrain the code rather than its behaviour.

| File | Rule |
|---|---|
| `web/privacy-sweep.test.ts` | No screen shows one member another's private data. |
| `web/viewer-required.test.ts` | Every function accepting a viewer is passed one, or is listed with a reason. |
| `web/privacy-by-id.test.ts` | Every parameterised route answers 404 for another member's private entity. |
| `web/privacy-by-url.test.ts` | Private loans and arrangements are unreachable by URL and absent from totals. |
| `web/redirect-safety.test.ts` | No request-supplied redirect target reaches a response unfiltered. |
| `web/cross-site-writes.test.ts` | A write without a same-origin `Origin` or `Referer` is refused and changes nothing. |
| `web/api-docs.test.ts` | `docs/API.md` documents every route, and documents no route that does not exist. |
| `web/link-coverage.test.ts`, `route-reachability.test.ts` | Every route is reachable by a link. |
| `web/mobile-reachability.test.ts`, `mobile-layout.test.ts` | Everything reachable on desktop is reachable below 900px. |
| `web/budget-scoped-screens.test.ts` | Screens that mean "one budget's money" honour the switcher. |
| `web/concurrent-writers.test.ts` | Interleaved writes from two members lose nothing and leave the cache correct. |
| `web/templates.test.ts`, `client.test.ts` | No backtick inside a template literal's own comments; the client script parses. |
| `ops/coverage.test.ts` | Every durable table is included in backup verification. |

## Unit coverage by area

| Area | Files |
|---|---|
| Engine | `engine.test.ts`, `identity.test.ts`, `rollover.test.ts`, `targets.test.ts`, `rollup.test.ts` |
| Domain | one per module: accounts, budget, transactions, loans, assets, goals, schedules, reconciliation, month-close, departure, commitments, family-loans, insights, networth |
| Import | `csv.test.ts`, `pdf-statements.test.ts`, `pieced-statement.test.ts`, `statement-passwords.test.ts`, `dedupe.test.ts`, `rules.test.ts`, `learning.test.ts`, `pipeline.test.ts`, `cas.test.ts`, `email-alerts.test.ts`, `cross-account-identity.test.ts`, `missing-detail.test.ts` |
| PDF | `reader.test.ts`, `rc4.test.ts` |
| Auth | `sessions.test.ts`, `tokens.test.ts`, `google.test.ts` |
| Ops | `backup.test.ts`, `restore.test.ts` |
| Web | page rendering, charts, routes, accessibility, demo sign-in, installability |

## Not covered automatically

- **Gmail fetching.** Requires a live OAuth grant. The message parser has
  fixtures; the fetch loop does not.
- **Real bank statements.** Exercised manually against a corpus that cannot be
  committed. Automated coverage uses generated fixtures plus a synthetic
  statement reproducing the split-figure layout.
- **Browser rendering.** A separate CDP-driven audit checks contrast, tap-target
  size, labelling, heading order, duplicate ids and overflow across every screen
  at two widths in both themes. It is not part of `npm test`.
