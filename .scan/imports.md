## RESUME
FINAL. Both decisions committed on branch worktree-agent-a2dfee0de555693ea (base b9a17a3): e19a874 D9a, then D9b. Patches in .scan/patches/imports/. Nothing left to do.

## Log
- reset to b9a17a3, npm ci
- D9a CONFIRMED: src/gmail/fetch-statement-card.test.ts failed 3/5 on base (Gmail: "could not open"); manual /import/pdf opened the same fictional SBI Card fixture (DOB 01011970 + card 4321). Fixed in src/gmail/fetch.ts statementCardDigits (routed account + its cards; all visible when route unknown). Suite 2209 pass. Committed + patch 0001.
- D9b: src/import/undo-upgrade.test.ts failed 2/3 on base. upgradeExisting records upgraded_by_batch_id in event after; undoBatch restores cleared/memo/raw_* unless changed since (then keptBecauseEdited). Suite 2212 pass, typecheck clean. Committed + patch 0002.
- Unverified: old upgrades (pre-change) have no batch id, not reversed. Manual /import/pdf still uses only account.last4, not card-table digits.
- Side find: withNotice appends ?notice after #hash (/settings#gmail?notice=) so the notice sits in the URL fragment, likely never shown. Not in scope.
