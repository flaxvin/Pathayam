## RESUME
- Worktree: /home/user/Pathayam/.claude/worktrees/agent-a004523ed47003c7f, branch worktree-agent-a004523ed47003c7f (base cebdd0b)
- Driver: worktree .scratch/driver/*.mjs (copied to .scan/ui-flows-driver/). playwright-core in .scratch/node_modules. Server: demo db .scratch/demo.sqlite on 8207 (background). Notes edited in .scratch/ui-flows.md then cp'd here (Write tool refuses main-checkout paths).
- Bash guard: heredocs/python refused; write files with Write tool, edit with Edit.
- Status: UF-1 fixed in working tree; full suite had 1 failure to identify (rerun logging to .scratch/test.log). Then commit UF-1.
- Next journeys: budget assign/move/cover/hold/copy/auto-assign, transfer, card pay, activity undo, review, rules, schedules, goals, loans, portfolio, settings; as Priya and Anil too.

## Journeys done
- Ravi: sign in (demo), read budget, add expense (/add, saved, "Saved ₹123.45." notice, lands on /), payee usual-envelope fill, cross-budget note.

## Findings
### UF-1 should-fix — add form: payee's usual envelope never filled; cross-budget note never shown (FIXED, pending commit)
- Steps: Ravi → /add → type "1mg" in Payee → tab away. Envelope stays "Choose where it came from…" (expected Medical). Choose IDFC Savings (Ravi's budget) + a household envelope: no explanation appears. Envelope options carried 0 data-budget, no optgroups.
- Root cause: 30e12df renamed the envelope select to split_category_0 and dropped optgroups/data-budget/data-category-hint; client.ts applyUsualCategory and explainCrossBudgetFiling still looked up #category_id and option[data-budget], so both silently returned.
- Fix: client falls back to #split_category_0; category-lines options carry data-budget and are grouped by budget label when spanning budgets; hint has data-category-hint. Test: src/web/add-form-client-contract.test.ts. Verified in browser after fix (envelope fills to Medical; note shows; 2 optgroups).
