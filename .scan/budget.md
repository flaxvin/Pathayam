# budget area scan
## RESUME
- Started 2026-10-21. Worktree: /home/user/Pathayam/.claude/worktrees/agent-a9b56b8dd4709738f, branch worktree-agent-a9b56b8dd4709738f (base cebdd0b).
- Fuzzer: .scan/budget-fuzzer.ts (copy into <worktree>/.scratch/, run `node --experimental-strip-types .scratch/budget-fuzzer.ts FROM TO STEPS`, R=1 for refusal stats).
- Fuzz done: seeds 1-8x100, 10-13x200, 100-140x300 (~13k steps): identity + rollup-vs-live (RTA and every category balance) clean, no crashes.
- BUDGET-SCAN-1 committed f1e0d8e, patch 0001 in .scan/patches/budget/. Full npm test 2143 pass.
- Fuzz also: seeds 200-205x200, 300-330x250 with semantic checks (departure ends even + envelope 0 in all later months; family-loan makes one loan; markPaid posts schedule amount & split sums; autoAssign RTA arithmetic). Departure: release 25, family-loan 15, call-it-even 8 — all clean.
- Next: semantic checks (departure family-loan, auto-assign, markPaid, reports totals), more seeds.

## Findings
### BUDGET-SCAN-1 (medium) digest reads the household, not the budget on screen
- monthAwaitingClose(db, today) in digest.ts had no budgetId: Priya's page nagged "September is over" after she closed hers; and stayed silent about hers once the household closed.
- hold-surplus divided one budget's RTA by every visible budget's spending (averageDailySpend without budgetIds) — BUDGET-20 fixed the buffer, not the digest.
- Fix: pass `budget` to both. Status: fixed f1e0d8e.

### BUDGET-SCAN-2 (low-medium) daily spending heatmap counts transfers and tracking rows
- spendingCalendar (reports.ts) summed every negative row: a card bill payment counted the charges twice; savings->FD transfer showed as spending.
- Test src/domain/spending-calendar.test.ts. Fix: exclude transfer legs and tracking accounts. Status: fixed, awaiting full test then commit.

## Notes (not fixed / outside)
- Departure family-loan ending: household RTA rises by the debt while the debt sits in an off-budget tracking account (by design per departure.ts comment). Not reported as a bug.
- by-date-repeating and schedule-linked target types exist in engine/schema but no code path creates them (setTarget accepts monthly/refill/by-date only; loadTargets never fills scheduleAmount/scheduleDue). Dead code; a by-date-repeating past its date asks the whole remaining amount every month (no roll-forward). Unreachable from UI.
- monthAwaitingClose's "used" check counts transactions in every budget, so a personal budget with no activity last month is still nudged if the household had any. Low.
- POST /auto-assign does not wrap in withForwardRecompute (past-month ripple not logged). Low.
