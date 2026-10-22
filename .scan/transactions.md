## RESUME
DONE. D7 committed as 39fe58d on branch worktree-agent-a79963eb547534762 (base b9a17a3).
Patch: .scan/patches/transactions/0001-D7-a-partial-transaction-edit-keeps-the-fields-it-do.patch
Nothing left to do.

## Log
- Step 1: read POST /transaction/:id (src/app.ts ~3991) and its form (same file, ~3752).
- Step 2: 5 tests added to src/web/transaction-edit.test.ts ("D7 · a partial edit keeps what it does not mention"); 3 failed before the fix (date-only API edit; checkbox sent without marker; cleared_present marker in form); the 2 browser-behaviour guards passed before and after.
- Step 3: fix. Form: hidden cleared_present=1. Route: memo absent -> keep; cleared/reimbursable via checkbox(): own field sent -> value==="1", only marker -> false, neither -> keep; amount absent -> keep magnitude (blank still 400). Tags/owner/payee/direction/date/envelope lines already kept when absent.
- Step 4: docs/API.md route table row for POST /transaction/:id documents partial-edit semantics.
- Typecheck clean; full suite 2209/2209 pass.
