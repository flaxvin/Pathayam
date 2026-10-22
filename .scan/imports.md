## RESUME
D9a DONE and committed (see log). Next: D9b — failing test is at <worktree>/.scratch/undo-upgrade.test.ts (move back to src/import/), implement in src/import/pipeline.ts (upgradeExisting gets batchId, recorded in event after as upgraded_by_batch_id; undoBatch reverses), docs/money-in.md "Undoing an import".

## Log
- reset to b9a17a3, npm ci
- D9a verified failing (3/5 of src/gmail/fetch-statement-card.test.ts on base; manual /import/pdf opens same fixture). Fixed in fetch.ts statementCardDigits. Suite 2209 pass. Committed + patch.
- D9b test written, fails 2/3 on base (cleared+memo not restored; edited not listed).
- Side find: withNotice appends ?notice after #hash (/settings#gmail?notice=) so the notice sits in the URL fragment, likely never shown. Not in scope.
