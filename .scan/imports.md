## RESUME
D9a CONFIRMED (test src/gmail/fetch-statement-card.test.ts fails 3/5 on base: Gmail says could not open; manual /import/pdf opens). Fixture STATEMENTS.sbiCardEncrypted added in src/import/statements.test-data.ts. Next: implement fix in src/gmail/fetch.ts handleStatement, then commit D9a, then D9b.

## Log
- reset to b9a17a3, npm ci
- D9a verified failing
- Side find: withNotice appends ?notice after #hash (/settings#gmail?notice=) so the notice is in the fragment, likely never shown. Not in scope.
