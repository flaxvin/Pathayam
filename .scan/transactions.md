# transactions area scan

## RESUME
- STATUS: DONE (final). Worktree /home/user/Pathayam/.claude/worktrees/agent-a311879de08cb24a2, branch worktree-agent-a311879de08cb24a2, base main @ cebdd0b.
- Commits: d3157f0 (TX-1), 73282b5 (TX-2), 604516d (TX-3), 78a98ba (TX-4). Patches 0001-0004 in .scan/patches/transactions/ (apply in order with `git am`).
- Full suite green after each (2145-2148 tests, 0 fail; count varies run to run), typecheck clean.

## Findings
| id | sev | defect | repro | root cause | status |
|---|---|---|---|---|---|
| TX-1 | should-fix | Deleting an imported transfer from the leg dated after the other account's checkpoint also deletes the other leg, which is dated inside the reconciled period, without asking. The checkpoint stays intact over a cleared balance that moved | checkpoint-guards.test.ts "deleting the card's side asks about the bank's checkpoint..." | src/app.ts POST /transaction/:id/delete guarded the partner's account from this leg's date | fixed d3157f0 |
| TX-2 | should-fix | Undoing a transfer leg's own "create" event removes both legs but leaves the transfer's fee live (bank and charges envelope still down) | transfer-fees.test.ts "undoing either leg's own creation takes the charge too" | src/domain/transactions.ts transaction undo handler, create branch, never looked up the fee | fixed 73282b5 |
| TX-3 | nit | Activity offers Undo on an attachment removal. The undo reports success and marks the removal undone, but restores nothing | attachments.test.ts "a removal is not offered as undoable" | src/domain/attachments.ts registerUndoHandler without ["add"] | fixed 604516d |
| TX-4 | should-fix | POST /transaction/:id without `direction` (for example an API caller that changes only the date) turns income into uncategorised spending and reports "Saved." | transaction-edit.test.ts "an edit that does not say which way the money went" | src/app.ts edit route treated a missing direction as "out" | fixed 78a98ba |

## Exercised / clean
- All of transactions.ts read (create, update, delete, restore, purge, transfers, payees, tags, undo handlers); routes /add, /transfer, /transaction/:id (edit, delete, categorise, settled, attach), /attachment/:id; undo route with dry-run checkpoint detection.
- Clean: restore after category delete or merge (deleted transactions count as history and are remapped); purge versus the undo window (they cannot overlap); FKs referencing transactions are all covered by purge's dependant list or cascade; payee merge undo chain.

## Unverified / not fixed
- The edit route also writes memo (`|| null`) and cleared (`=== "1"`) on every POST. A partial API edit therefore clears the memo and marks the transaction uncleared. This is the same class as TX-4, but I did not write a test or fix it. An HTML checkbox cannot tell "absent" from "unchecked" without a `cleared_present` marker.
- The transfer undo handler soft-deletes legs even when they are already deleted, which pushes deleted_at forward (and so extends the purge window). Minor; not tested.
## Outside my area
(none)
