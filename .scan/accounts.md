## RESUME
- Branch: worktree-agent-ab203305b0f30857a (worktree .claude/worktrees/agent-ab203305b0f30857a)
- Status: DONE. Commits 0036657 (ACC-1), 60f4cb8 (ACC-2), 66e851c (ACC-3); patches in .scan/patches/accounts/. Full suite 2145/2145 pass, typecheck clean. Final report sent.
- Next: none (stopped on time). Possible follow-ups: M4 capitalisation decision, recordReturnOfCapital validation.

## Exercised
- amortisation.ts read in full (EMI, flat, moratorium, comparePrepayment, rate reset) - clean by reading.
- tax.ts read in full (slabs FY25/26, 87A, special-rate gains, surcharge band test, 80D EXTRA-6) - no defect found.
- fire.ts read - no defect found. networth simple tracking accounts are always INR (createAccount hardcodes INR) so no FX issue.

## Findings
### ACC-1 (Medium) Flat-rate loan: "reduce tenure" prepayment RAISES the instalment
- Repro: flat 2,40,000 @15% x24 => EMI 13,000 (10,000 principal + 3,000 interest). Pay 12; prepay 30,000 mode=tenure.
  Expected 90,000/10,000 = 9 months, tenure 21, EMI 13,000. Got tenure 20, EMI 14,250 (90,000/8 + 3,000).
- Root cause: keepInstalment priced months with reducing-balance buildSchedule even for flat loans.
- Fix: for flat, months = ceil(outstanding / (emi - flatMonthlyInterest(base, rate))). Test src/domain/loan-flat-kept-instalment.test.ts.
### ACC-2 (Medium) Interest-only payments (serviced moratorium / pre-EMI) end the moratorium and consume tenure
- Repro: education 10L @10%, M3 moratorium 12, tenure 120. Before: preEmi 8,333.33, EMI 13,215.07 (120m).
  Record 8,333.33 interest-only (principal 0) => moratorium null, preEmi null, EMI 13,279.90 over 119m.
- Root cause: every kind='instalment' row counted as a tenure month and as "repayment begun".
- Fix: count only instalments with principal > 0 (repaysAnInstalment) in projectLoan + keepInstalment. Test src/domain/loan-interest-only.test.ts.
### Decision for owner: M4 capitalised moratorium interest vanishes on first EMI
- Before first EMI projection shows 11,04,713.07 balance at repayment start (10L*(1+r)^12); after first EMI (14,598.86) outstanding = 9,93,734.47 (projection split 8,333.33 interest on 10L) and EMI 13,196.70. Capitalised interest (1,04,713) is never materialised into the loan's outstanding/net worth. Workaround: reanchor to lender balance. Recommend: on first principal-repaying instalment of an M4 loan, insert a dated capitalisation row (negative principal, like reanchor) - schema/semantics decision.
### ACC-3 (Medium) Closing an account with a balance silently drops it from net worth
- Repro: bank opening 50,000 + card owing 20,000 => net worth 30,000. closeAccount both => net worth 0; Ready to Assign still 50,000. docs/accounts.md promised "warns before closing" - no warning existed. Also /accounts/:id/close on a family-loan tracking account bypassed WEALTH-30's refusal.
- Fix: closeAccount refuses budget/credit/plain-tracking/family-loan accounts with non-zero ledger balance (names amount). Sim scenario now exercises close/reopen on an empty "Old wallet". docs/accounts.md updated. Test src/domain/account-close-balance.test.ts.
### Notes (not fixed, low)
- recordReturnOfCapital: no validation (amount<=0, amount>basis => negative lot cost); no route reaches it (only sim) - latent.
- viewHolding with no quote values a FOREIGN holding at averageCost(base) x fx (double conversion); routes always record a purchase price so not reached via UI.
- Unverified: gold ETF long-term threshold (12 vs 24 months after Finance Act 2024/2025) in capital-gains-tax.ts (gold always 24m).
