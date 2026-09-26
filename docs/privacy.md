# Privacy within a household

## Model

The household has one budget. Each member may have one personal budget.

```
budgetsFor(member) = [ household budget, that member's personal budget ]
```

Everything a member may see follows from that set, plus the visibility flag on
individual accounts.

## Visibility

`accounts`, `loans` and `family_loans` each carry `visibility` (`household` or
`private`) and `holder_member_id`. The predicate is identical everywhere:

```sql
(visibility <> 'private' OR holder_member_id IS ?)
```

A private entity is excluded from:

- lists and registers;
- every picker and dropdown, and the write side of every form;
- reports, queries, insights and the CSV and JSON exports;
- the activity log, including event summaries that merely name it;
- payee lists, where a payee has only ever been seen on invisible accounts;
- **totals**, including net worth, so nothing is recoverable by subtraction.

A net-worth snapshot is one shared row per date, read back by every member (the
history, the change line, `/net-worth.csv`), so it is taken as nobody in
particular: household accounts only, nothing held privately. Each member's live
statement still counts their own private accounts; the history does not.

Categories and groups are scoped by `budget_id`: a member sees envelopes in the
household budget and in their own.

## Enforcement

### Response

A request for an entity the viewer may not see returns **404**, never 403. The
existence of a private entity is itself disclosive.

### Guards

Route handlers resolve identifiers through functions that return only what the
viewer may see, then pass the result to the domain:

| Guard | Resolves | Checks |
|---|---|---|
| `requireVisibleAccount` | account id | account visibility |
| `requireVisibleTransaction` | transaction id | its account, its category **and** its split lines' categories |
| `requireVisibleCategory` | category id | the category's budget |
| `requireVisibleGroup` | group id | the group's budget |
| `requireVisibleAttachment` | attachment id | the attachment's transaction |
| `requireVisibleStaged` | staged statement line id (approve, dismiss, merge) | the account it was imported into |
| `requireVisibleSchedule`, `requireVisibleGoal`, `requireVisibleHolding`, `requireVisibleInstrument` | schedule, goal, holding, instrument id | `memberScope` — what the thing hangs off |
| `requireVisibleEvent` | event id (undo) | `eventVisibility` |
| `requireVisibleRule`, `requireVisibleImportProfile` | rule, profile id | the envelope / account it names |

A form field naming an account (`/add`, `/transfer`, `/schedules/new`,
`/portfolio/add`, a loan's repayment account, a sale's destination) goes
through `requireVisibleAccount` too, so a private account id and a made-up one
both answer 404 — a 422 for one and not the other would confirm which exists.

`src/domain/member-scope.ts` computes, once per request, every id a member may
not see: budgets and accounts at the root, and every transaction, schedule,
goal, card, holding, lot, instrument and loan by what it hangs off. A new kind
of private thing belongs there, so the guards, the activity log and the export
learn it at once.

A list that filters in SQL uses the same rule from the same file:
`hiddenTransactionSql` (the account **or** any envelope a transaction is filed
to) and `hiddenAccountSql`. The account register, Query, Search, the reports,
the review queue and its badge, and the import history all read through them.
A household-visible account in a member's own budget is visible; the rows on it
filed to that member's envelopes are not, exactly as on the transaction page.

Domain and query functions that can return data for a viewer take
`viewerMemberId` and apply the predicate in SQL: `listAccounts`,
`listCategories`, `queryTransactions`, `netWorthStatement`, `assetAllocation`,
`casDestinations`, `exportHoldingsCsv`, `exportLotsCsv`, `projectCashflow`,
`spendingInsights`, `listPayees`, `buildBudgetView`, `digestFor`,
`detectSchedules`, `subscriptions`, `eventVisibility` and others.

### Export and backup

`/export.json` and `/export.csv` are a **member's export**
(`src/ops/member-export.ts`): what that member can read on screen, with control
totals recomputed over what is in the file. The **operator's backup**
(`createBackup`, `exportEverything`, restore) stays whole — every member's
private budget included — and runs only on the server, never through a
member's browser.

### Event visibility

`eventVisibility(db, viewerMemberId)` returns a predicate over logged events.
An event is hidden when its entity id, or any id recorded in its before/after
state, is one `memberScope` hides — so a deleted private schedule's delete
event stays private too. `assignment`, `target` and `transfer` are judged by the
category or legs their id names; `payee` by whether the payee has been seen on a
visible account.

Kinds that are the household's own business (settings, members, sessions,
backups, the price feed, the shared net-worth snapshot and similar) are listed
explicitly and shown to everyone. **Any other kind is hidden** until it is
declared household business — the default is deny.

Undo (`/activity/:id/undo`) resolves the event through the same predicate, so
another member's private change answers 404.

### Budget-scoped moves

A category group and the envelopes in it always share a `budget_id`. Deleting a
goal hands its envelope back into a "Savings" group of the goal's own budget,
never the household's.

## Automated checks

These test files enforce the model, each covering a different failure mode:

| File | Method |
|---|---|
| `src/web/privacy-sweep.test.ts` | Plants unique strings in each kind of private entity, renders every non-parameterised GET route as a member who cannot see them, fails on any match. The route list is read from the router. |
| `src/web/viewer-required.test.ts` | Reads every function accepting `viewerMemberId` from the source, and requires every call in `app.ts` to pass one or to be listed with a written reason. |
| `src/web/privacy-by-id.test.ts` | Aims every parameterised route at another member's private account, transaction, category, group and attachment, and requires 404. |
| `src/web/privacy-by-url.test.ts` | Per-loan and per-arrangement routes, including that a private loan stays out of the net-worth total. |
| `src/web/member-privacy.test.ts` | Builds one member's private budget with one of everything; as another member, aims every id-addressed route in the router at each of those ids (none may answer 200/303), and checks that undo, the exports, the digest, schedules, allocation, CAS, portfolio CSVs and net-worth history carry none of its names or balances. |

## Commitments

A personal budget commits money to the household by assigning to an envelope
carrying `commits_to_budget_id`. No money moves between accounts and neither
side sees the other's accounts; the household's means increase by the sum of
commitment envelopes, exposed as `due from other budgets`.

The standing of a commitment is **overfunded**, **underfunded** or **square**.

## Impersonation

Available only when `ADMIN_DEBUG` is set. A session may view the application as
another member:

- read-only by default; writes require an explicit toggle
  (`impersonation_writes`) and expire;
- a banner appears on every page;
- events record both `actor_member_id` and `real_member_id`;
- display preferences are stored against the real member.

## Departure

Removing a member sets `removed_at`. Nothing they created is deleted and their
name remains on it. Before removal the household settles any balance between
budgets. A removed member can be restored, and is found by the same identity.
