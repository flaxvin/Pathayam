# transactions area scan

## RESUME
- Worktree: /home/user/Pathayam/.claude/worktrees/agent-a311879de08cb24a2 (branch worktree-agent-a311879de08cb24a2), base main @ cebdd0b
- Status: 2 findings reproduced+fixed in working tree (uncommitted as of this write; check `git log`/`git status`).
- Next: commit TX-1 and TX-2 separately (tests in src/web/checkpoint-guards.test.ts, src/domain/transfer-fees.test.ts), format-patch; then keep auditing: attachments, payee merge undo, tags, purge, /transaction/:id edit with card_id/owner, split re-edit sequences.

## Findings
| id | sev | defect | repro | root cause | status |
|---|---|---|---|---|---|
| TX-1 | should-fix | Deleting an imported transfer from the leg dated after the other account's checkpoint deletes the other leg (dated inside the reconciled period) without asking; checkpoint stays intact over a changed cleared balance | checkpoint-guards.test.ts "deleting the card's side asks about the bank's checkpoint..." | src/app.ts POST /transaction/:id/delete guarded partner account with this leg's date, not partner's own date | fixed (uncommitted) |
| TX-2 | should-fix | Undoing a transfer leg's own "create" event removes both legs but leaves the transfer's fee transaction live (bank and charges envelope still down ₹5) | transfer-fees.test.ts "undoing either leg's own creation takes the charge too" | src/domain/transactions.ts transaction undo handler create branch never looked up the fee (only the "transfer" handler did) | fixed (uncommitted) |

## Exercised
- read transactions.ts fully, delete/edit/add/transfer routes, undo route, checkpoint guards
## Outside my area
