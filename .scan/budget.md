# budget area scan
## RESUME
- STATUS: DONE (2026-10-21). Branch worktree-agent-a9b56b8dd4709738f: f1e0d8e SCAN-1, c369b01 SCAN-2, a5b309a SCAN-3 (1-3 integrated by coordinator), 16b3bdf SCAN-4 (patch 0004, not yet integrated).
- Full npm test after SCAN-4: 2148/2148 pass; typecheck clean.
- Fuzzer: .scan/budget-fuzzer.ts (copy to <worktree>/.scratch/, `node --experimental-strip-types .scratch/budget-fuzzer.ts FROM TO STEPS`; R=1 refusal stats, V=1 verbose). Note: uses SQLite random() for picks, so a seed is not fully reproducible.
- Fuzz total ~30k steps: seeds 1-8x100, 10-13x200, 100-140x300, 200-205x200, 300-330x250, 400-425x250 (x2). Checks per step: identity in every scope/month, live vs rollup RTA and every category balance, RTA explain lines sum to RTA; semantic: departure ends even with later months zeroed (release/family-loan/call-it-even all exercised), family-loan creates one loan, markPaid posts schedule amount and split sums, auto-assign RTA arithmetic. Only defect found: SCAN-4.

## Findings
### BUDGET-SCAN-1 (medium) digest reads the household, not the budget on screen
- monthAwaitingClose(db, today) in digest.ts had no budgetId: Priya's page nagged "September is over" after she closed hers; and stayed silent about hers once the household closed.
- hold-surplus divided one budget's RTA by every visible budget's spending (averageDailySpend without budgetIds) — BUDGET-20 fixed the buffer, not the digest.
- Fix: pass `budget` to both. Status: fixed f1e0d8e.

### BUDGET-SCAN-2 (low-medium) daily spending heatmap counts transfers and tracking rows
- spendingCalendar (reports.ts) summed every negative row: a card bill payment counted the charges twice; savings->FD transfer showed as spending.
- Test src/domain/spending-calendar.test.ts. Fix: exclude transfer legs and tracking accounts. Status: fixed c369b01, patch 0002.

### BUDGET-SCAN-3 (low-medium) cashflow projection charges every loan's instalment to every budget
- projectCashflow scoped accounts/schedules/cards by budget but listed every visible loan: Ravi's personal projection (and digest shortfall) paid the household home loan out of his cash.
- Test added in src/web/budget-scoped-screens.test.ts. Fix: skip a loan whose repayment account is neither in scope nor an in-scope card. Status: fixed a5b309a, patch 0003 (integrated by coordinator).

### BUDGET-SCAN-4 (medium) undoing a schedule split change restores lines on merged/deleted envelopes
- Found by fuzz seed 411 (FOREIGN KEY constraint failed on undo). Repro: split schedule [A,B] -> [A,C]; merge or delete B; undo the second split (force) -> lines [A,B(gone)] restored; next Mark paid refused. Row hard-gone -> FK error (500).
- Test src/domain/schedule-split-undo-gone.test.ts. Fix: split undo handler refuses when any restored envelope is missing/deleted. Status: fixed 16b3bdf, patch 0004.

## Notes (not fixed / outside)
- Departure family-loan ending: household RTA rises by the debt while the debt sits in an off-budget tracking account (by design per departure.ts comment). Not reported as a bug.
- by-date-repeating and schedule-linked target types exist in engine/schema but no code path creates them (setTarget accepts monthly/refill/by-date only; loadTargets never fills scheduleAmount/scheduleDue). Dead code; a by-date-repeating past its date asks the whole remaining amount every month (no roll-forward). Unreachable from UI.
- monthAwaitingClose's "used" check counts transactions in every budget, so a personal budget with no activity last month is still nudged if the household had any. Low.
- POST /auto-assign does not wrap in withForwardRecompute (past-month ripple not logged). Low.
