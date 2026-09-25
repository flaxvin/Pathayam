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
| `requireVisibleTransaction` | transaction id | its account **and** its category |
| `requireVisibleCategory` | category id | the category's budget |
| `requireVisibleGroup` | group id | the group's budget |
| `requireVisibleAttachment` | attachment id | the attachment's transaction |

Domain and query functions that can return data for a viewer take
`viewerMemberId` and apply the predicate in SQL: `listAccounts`,
`listCategories`, `queryTransactions`, `netWorthStatement`, `projectCashflow`,
`spendingInsights`, `listPayees`, `buildBudgetView`, `eventVisibility` and
others.

### Event visibility

`eventVisibility(db, viewerMemberId)` returns a predicate over logged events. An
event is readable when the entity it concerns is:

| Entity | Test |
|---|---|
| `account` | account predicate |
| `category`, `goal` | category's budget is visible |
| `loan`, `family-loan` | holder predicate |
| `transaction` | its account and its category |
| `assignment` | the category in `month:categoryId` |
| `target` | the category |
| `transfer` | both legs' accounts |
| `payee` | the payee has been seen on a visible account |
| `holding`, `asset` | the holding's account |
| anything else | visible — a household setting, a member, a rule |

## Automated checks

Three test files enforce the model, each covering a different failure mode:

| File | Method |
|---|---|
| `src/web/privacy-sweep.test.ts` | Plants unique strings in each kind of private entity, renders every non-parameterised GET route as a member who cannot see them, fails on any match. The route list is read from the router. |
| `src/web/viewer-required.test.ts` | Reads every function accepting `viewerMemberId` from the source, and requires every call in `app.ts` to pass one or to be listed with a written reason. |
| `src/web/privacy-by-id.test.ts` | Aims every parameterised route at another member's private account, transaction, category, group and attachment, and requires 404. |
| `src/web/privacy-by-url.test.ts` | Per-loan and per-arrangement routes, including that a private loan stays out of the net-worth total. |

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
