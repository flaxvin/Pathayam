# loans: capitalise moratorium interest on first EMI

## RESUME
- Step 1: design done, writing failing test src/domain/loan-moratorium-capitalise.test.ts. No commits yet.
- Worktree: /home/user/Pathayam/.claude/worktrees/agent-a6584560f7bc0325b (base b9a17a3)

## Design
- Re-anchor mechanism (reanchorToLenderBalance): inserts loan_payments row kind='charge', amount 0,
  principal = projected - lender (negative raises outstanding), no loan-account leg; undo deletes row.
- Capitalisation row: same shape (kind charge, amount 0, principal = -C, interest 0) PLUS a loan-account
  transaction of -C (so account balance == outstanding; no drift), flagged by new column
  loan_payments.capitalises_moratorium (migration 0060). Dated the instalment's date, inserted first.
- C = projectLoan(...).moratorium.capitalisedInterest just before the instalment (the figure the app showed).
- Only when: model moratorium-capitalised, months>0, kind instalment, resulting principal>0, no prior
  repaying instalment, no capitalisation row yet, no re-anchor (charge, amount 0, not capitalisation) dated <= instalment date
  (a lender balance taken during moratorium already includes accrued interest).
- Estimated split + principal>owed check use outstanding + C.
- Instalment event after carries capitalisationId; undo deletes row + erases leg. Undo refused if a later
  re-anchor exists (it was measured against the capitalised balance) -> undo the re-anchor first.
- paidPrincipal (metrics) excludes capitalisation rows.

## Migration decision
- No backfill. Evidence: all 8 backups in /home/user/Pathayam/data/backups have 0 moratorium loans
  (only reducing/flat, moratorium_months 0); seed/sim create none. Unsafe in general: later splits were
  estimated on the understated balance, a mid-life loan may have been entered with a capitalised
  outstanding already, or a statement/re-anchor may already have corrected it -> would double count.
