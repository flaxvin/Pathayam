# loans: capitalise moratorium interest on first EMI

## RESUME
- Step 3: implemented + docs; full npm test running (first run: only failure was README migration
  count -> dropped the migration). Next: confirm green, commit, format-patch, final notes.
- Worktree: /home/user/Pathayam/.claude/worktrees/agent-a6584560f7bc0325b (base b9a17a3)

## Files
- src/domain/loans.ts: moratoriumInterestToCapitalise, capitaliseMoratoriumInterest, isMoratoriumCapitalisation,
  IS_CAPITALISATION_SQL / IS_REANCHOR_SQL; recordInstalment uses outstanding + C for estimated split & owed check;
  undo handler removes the row+leg, refuses if later instalment/re-anchor; metrics paidPrincipal excludes it.
- src/web/pages/loans.ts: payments table kind cell "moratorium interest added".
- src/domain/loan-moratorium-capitalise.test.ts (new, 11 tests).
- docs/loans-and-assets.md (new section "A capitalised moratorium", undo table), docs/data-model.md.

## Design
- Row = re-anchor shape (kind charge, amount 0, principal -C, interest 0) PLUS loan-account leg -C
  (loan_transaction_id) so account balance == outstanding, no drift. Leg is the marker (no column ->
  no migration; a migration would bump README's exact migration count, which I must not touch, and could
  clash with parallel branches' 0060).
- C = projectLoan().moratorium.capitalisedInterest just before the instalment.
- Only when: model moratorium-capitalised, months>0, kind instalment, resulting principal>0, no prior repaying
  instalment, no capitalisation row, no re-anchor dated <= instalment date.
- Instalment event after carries capitalisationId; undo deletes it; refused if later instalment/re-anchor (rowid).

## Migration decision
- No backfill. Evidence: all 8 backups in /home/user/Pathayam/data/backups have 0 moratorium loans
  (only reducing/flat, moratorium_months 0); seed/sim create none. Unsafe in general: later splits were
  estimated on the understated balance, a mid-life loan may have been entered with a capitalised
  outstanding already, or a statement/re-anchor may already have corrected it -> double count.

## Arithmetic
10,00,000*(1+1/120)^12 = 11,04,713.07; EMI 14,598.86; 1st EMI int 9,205.94 prin 5,392.92 -> 10,99,320.15;
emiFor(10,99,320.15,10,119)=14,598.86. Old buggy figure confirmed by failing test: 9,93,734.47.
