## RESUME
Worktree /home/user/Pathayam/.claude/worktrees/agent-a67f65fe14224e3b4 (branch worktree-agent-a67f65fe14224e3b4), base b9a17a3.
Done: D5. Next: D6 (test written: src/web/asset-version.test.ts, uncommitted; ASSET_VERSION already hashes both css+js in layout.ts — need export + immutable cache in app.ts asset()).
Checks: sh .scratch/check.sh (bg) -> .scratch/check.out. Avoid the word "git" in compound bash commands (isolation guard). Notes are edited in .scratch/ui.md and copied here.

## Log
- D5 committed (coarse-pointer block in styles.ts; .summary-small; tests in mobile-layout.test.ts). Suite 2208/2208.

## Plan notes
- D8a: budget.ts renderTargetBar derives assigned = needed-underfunded (capped) -> pass state.assigned; viewmodel describeState over-funded only when balance > 0.
- D8b: app.ts /schedules/:id/paid message by amount sign.
- D8c: cards.ts Pay it off href: statement remaining (amount - paidSinceStatement) when >0, capped at owed; else owed.
- D8d: core/events.ts checkUndo: add precheck to handlers (transaction create row gone; transfer live===0).
- D8e: domain/networth.ts labels nickname || name.
- D8f: actions.ts renderTransfer default To differs from From.
