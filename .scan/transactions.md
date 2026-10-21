# transactions area scan

## RESUME
- Worktree: /home/user/Pathayam/.claude/worktrees/agent-a311879de08cb24a2 (branch worktree-agent-a311879de08cb24a2), base main @ cebdd0b
- Committed + patched: TX-1 d3157f0, TX-2 73282b5, TX-3 604516d (patches 0001-0003 in .scan/patches/transactions/).
- TX-4 fixed in working tree (src/app.ts edit route direction + src/web/transaction-edit.test.ts); full suite running -> commit + format-patch -1 when green.
- Next: brief further audit (purge of transfer pairs, tags privacy), then final report.

## Findings
| id | sev | defect | repro | root cause | status |
|---|---|---|---|---|---|
| TX-1 | should-fix | Deleting an imported transfer from the leg dated after the other account's checkpoint deletes the other leg (dated inside the reconciled period) without asking; checkpoint stays intact over a changed cleared balance | checkpoint-guards.test.ts "deleting the card's side asks about the bank's checkpoint..." | src/app.ts POST /transaction/:id/delete guarded partner account with this leg's date | fixed d3157f0 |
| TX-2 | should-fix | Undoing a transfer leg's own "create" event removes both legs but leaves the transfer's fee live (bank and charges envelope still down) | transfer-fees.test.ts "undoing either leg's own creation takes the charge too" | transactions.ts transaction undo handler create branch never looked up the fee | fixed 73282b5 |
| TX-3 | nit | Activity offers Undo on an attachment removal; it "succeeds", marks the removal undone, restores nothing | attachments.test.ts "a removal is not offered as undoable" | attachments.ts registerUndoHandler without ["add"] | fixed 604516d |
| TX-4 | should-fix | POST /transaction/:id without `direction` (API caller changing only date) flips income to spending, uncategorised, under "Saved." | transaction-edit.test.ts "an edit that does not say which way the money went" | src/app.ts edit route defaulted missing direction to "out" | fixed, uncommitted |

## Exercised
- transactions.ts fully read; delete/edit/add/transfer/categorise/settled/attach routes; undo route + dry-run checkpoint logic; attachments; payee merge + undo; purge; category delete/merge vs restore (clean: deleted txns count as history / are remapped)
## Outside my area
(none)
