## RESUME
- Worktree: /home/user/Pathayam/.claude/worktrees/agent-a004523ed47003c7f, branch worktree-agent-a004523ed47003c7f (base cebdd0b)
- Driver: worktree .scratch/driver/*.mjs (copied to .scan/ui-flows-driver/). playwright-core in .scratch/node_modules. Server: demo db .scratch/demo.sqlite on 8207 (background; died once during npm test — restart if /healthz fails).
- Bash guard: heredocs/python refused; write files with Write tool, edit with Edit. Notes edited in .scratch/ui-flows.md then cp'd to .scan.
- Status: UF-1..UF-4 fixed in working tree, tests written; full suite running (.scratch/test.log). When green: commit each separately (files listed per finding), format-patch each.
- Next journeys (time left ~35 min): review queue, schedules, goals, loans; Priya/Anil privacy spot-checks; settings.

## Journeys done
- Ravi: sign in (demo); read budget; add expense (Saved ₹123.45 → /); payee usual-envelope fill; cross-budget note; inline assign (RTA −1000, notice correct); move Water→Broadband (correct); Cover overspend (UF-2); hold ₹2,000/₹5,000/release (Oct RTA correct; Nov unchanged by design since unheld RTA carries anyway); Cards "Pay it off" → /transfer prefilled, Transfer recorded, card ₹0 "Paid"; Activity undo of transfer, then of its legs (UF-4).

## Findings
### UF-1 should-fix — add form: payee's usual envelope never filled; cross-budget note never shown (FIXED)
- Steps: Ravi → /add → type "1mg" in Payee → tab away. Envelope stays "Choose where it came from…" (expected Medical). Choose IDFC Savings (Ravi's budget) + a household envelope: no explanation appears. Envelope options carried 0 data-budget, no optgroups.
- Root cause: 30e12df renamed the envelope select to split_category_0 and dropped optgroups/data-budget/data-category-hint; client.ts applyUsualCategory and explainCrossBudgetFiling still looked up #category_id and option[data-budget], so both silently returned.
- Fix: client falls back to #split_category_0; category-lines options carry data-budget and are grouped by budget label when spanning budgets; hint has data-category-hint. Files: src/web/client.ts, src/web/pages/category-lines.ts, src/web/pages/actions.ts, test src/web/add-form-client-contract.test.ts. Verified in browser.

### UF-2 BLOCKING — every move from Ready to Assign 404s ("That envelope does not exist."), incl. Cover → "Ready to Assign" (FIXED)
- Steps: Ravi → budget → Domestic help "Cover ₹3,860" → click "Ready to Assign · ₹58,925.51" suggestion → error "That envelope does not exist.", POST /move 404. Same for /move with the default From (Ready to Assign).
- Root cause: 6efbf04 wrapped from_category_id in requireVisibleCategory; "rta" is not an envelope id.
- Fix: src/app.ts POST /move skips the guard for "rta". Test src/web/move-from-rta.test.ts.

### UF-3 should-fix — Cards "Due within a week: 1" counts a paid statement (FIXED)
- Steps: Ravi → /cards. Axis Atlas shows "Paid" (due 10-10, 11 days ago), others due in 12/15 days, header says Due within a week 1.
- Root cause: src/web/pages/cards.ts dueSoon filter = daysToDue <= 7, ignoring the paid state that urgency() already knows.
- Fix: exclude cards urgency() calls Paid. Test src/web/cards-due-soon.test.ts.

### UF-4 should-fix — Activity: undoing a transfer's leg after the transfer was undone (or vice versa) reports a removal that did not happen and logs a bogus undo (FIXED)
- Steps: Cards → Pay it off → Record transfer. Activity → Undo "Paid ₹5,190 to Amazon Pay ICICI" ("Reversed the transfer"). Then Undo "Received ₹5,190" → "Removed the transfer that was added, both sides"; then Undo "Spent ₹5,190" → "Removed the transaction that was added". Balances unchanged each time (HDFC ₹84,352.90, card −₹5,190) but two more undo entries logged; the leg undo also hard-deleted the soft-deleted rows.
- Root cause: src/domain/transactions.ts undo handlers for transaction-create and transfer never checked whether the rows were already deleted.
- Fix: both handlers throw UndoRefused ("already been removed") when nothing live is left. Test in src/domain/engine-undo.test.ts.
- Remaining (decision): Activity still shows the Undo button on such legs (refused on click with a sentence). Recommend checkUndo consult the handler or mark sibling events undone.

### UF-5 BLOCKING — buttons with formaction or name/value are ignored by the client: Review "No thanks" CONFIRMS the proposed rule; Move suggestion buttons send the select's default source (FIXED)
- Steps: Priya → /review → Proposed rules → "Axis Bank → Axis personal loan" → No thanks. Network: POST /rules/confirm; notice "Rule confirmed."; the rule is now live. Screenshot .scan/screens/ui-flows/review-no-thanks-confirms.png (taken pre-fix). Same mechanism: Cover → suggestion "Kerala trip" posted from_category_id=rta (select default), not the button's value.
- Root cause: src/web/client.ts submitWithRetry posted form.action with new FormData(form), ignoring event.submitter (its formaction and name/value).
- Fix: pass event.submitter; use its formAction when it has formaction; formData.set(name, value) for a named submitter; "Saving…" shown on the pressed button. Test in src/web/client.test.ts. Verified in browser: No thanks → POST /rules/dismiss "Won't suggest that again."; Cover from Kerala trip moved ₹3,860 out of Kerala trip, RTA unchanged.

### UF-6 should-fix — every chart logs console errors "<svg> attribute height: Expected length, "auto"" (FIXED)
- Steps: Anil → /schedules (also /reports): 4 console errors per load.
- Root cause: src/web/charts.ts emitted height="auto" on six chart SVGs.
- Fix: drop the attribute (width=100% + viewBox size it). Test in src/web/charts.test.ts. Screenshot check: cashflow chart renders the same, no console errors.

## Journeys done (cont.)
- Priya: /accounts + /add account list (no Ravi-private IDFC Savings — privacy OK); Review proposed rules (UF-5).
- Anil: /accounts list (privacy OK); Schedules: Arrived (RTA +₹12,000, next due → 20-12) and Skip (→ 20-01-2027), correct.

### UF-7 nit — Net worth names an account by its legal name ("ICICI Current"), everywhere else by its nickname ("Business current") (NOT FIXED)
- Steps: Priya → /accounts shows "Business current ····6612 ₹24,000"; /net-worth lists "ICICI Current ₹24,000". Net worth code never reads nickname.

## More journeys done
- Ravi: Loans → Education loan → Record an instalment (defaults) → "Instalment recorded.", outstanding ₹8,11,994.29 → ₹8,05,216.33 (= − ₹6,777.96 principal), 84 → 83 left. Correct.
- Priya: double-click Save on /add → exactly one transaction (search). Goals page reads. Net worth (privacy note present; balances agree with /accounts).
- Anil: theme toggle from /cards: dark → light, stays on /cards, survives reload.

## Decisions for owner
- Budget row "Over-funded ₹700 of ₹700" when ₹1,000 assigned against a ₹700 target: the "of" pair caps at target; recommend "₹1,000 of ₹700".
- Budget top: "Worth knowing" repeats the three unfunded-card notices that follow immediately as banners.
- "Pay it off" prefills the whole balance (₹5,190) not the statement (₹4,030); fine, but the minimum/statement amount could be offered as a choice.
- Income schedule "Arrived" answers "Marked paid." — say "Marked as arrived." for money in.
- After covering an overspend, the envelope reads "Over-funded ₹2,900 of ₹2,900" with balance ₹0 — status is from assigned vs target, not from what is left.
- One /move writes two Activity entries ("Moved ₹300 out to Broadband" and "Moved ₹300 from Water to Broadband"), each with its own Undo.
