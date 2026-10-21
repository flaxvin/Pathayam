# imports audit notes
## RESUME
- Branch: worktree-agent-a5c162eb1ae12bfab (worktree /home/user/Pathayam/.claude/worktrees/agent-a5c162eb1ae12bfab)
- Status: DONE. F1-F6 committed (574d89b c843067 2ec135a d207e45 1829769 b38cf94); full suite 2149/2149 pass, typecheck clean; patches in patches/imports; .scratch removed.
- Files: F1 src/import/csv.ts+csv.test.ts; F2 src/import/cas.ts+cas.test.ts; F3 src/import/pipeline.ts+import-transfer.test.ts; F4 src/gmail/fetch.ts+src/app.ts(/gmail/fetch)+src/gmail/fetch-notice.test.ts
- Next: none (final report sent). Open: D4 upgradeExisting not reversed by undoBatch; Gmail PDFs lack cardDigits for passwords.
## Findings
- F1 (Medium) TSV whose lakh figures/narrations carry more commas than tabs detected as comma -> header one cell -> unmappable (mapping screen has hidden delimiter, cannot change). Root: detectDelimiter counts chars. Fix: pick delimiter giving most lines of a steady width. FIXED (committed)
- F2 (Low) parseCasDate accepted 31/02/2026 -> lot dated 2026-02-31; also period. Fix: calendarDate. FIXED (committed)
- F3 (Medium, 500) approveStagedAsTransfer didn't retire a deleted twin's source_id: approve->delete->reimport->record as transfer->restore deleted = UNIQUE constraint 500. Fix: shared retireDeletedTwin in stampImportedLeg. FIXED (committed)
- F4 (Low-Med) /gmail/fetch notice: "N to an unknown account, all in Review" (not staged), auto-approved counted as in Review, locked/unmatched statement PDFs never mentioned ("nothing new"). FIXED (committed)
- F5 (Medium) extractNarrationFields VPA regex allowed '-' in local and '.-' in handle: HDFC "UPI-SWIGGY-swiggy@icici-ICIC0DC0099-<RRN>-Payment" -> vpa "upi-swiggy-swiggy@icici-...-payment", merchant "Upi Swiggy Swiggy"; IndusInd "/-12345678@ptyb" -> payee "12345678"; numeric VPA part chosen as merchant "9876543210@paytm". Fix in src/import/rules.ts (+rules.test.ts). FIXED (committed)
- F6 (Medium) FIXED b38cf94 Undoing a Review merge from Activity restores the transaction but leaves the staged row 'merged' -> imported row gone from Review (repro .scratch/t4.ts mode undo-merge-event). And undoBatch leaves a merged row's changes (cleared=1, raw_narration) on the pre-existing manual txn, staged row stays 'merged', reports "removed 0" (lead #4 confirmed).
- Gmail statement PDFs: handleStatement calls passwordCandidates without cardDigits, so SBI Card/Canara/HSBC statements (card digits needed) can never open via Gmail (code-read only; now at least reported as "could not open").
- Clean: parseAmount (lakh, Dr/Cr, brackets, ₹/Rs/INR), parseAlertDate calendar check, dedupe tiers read, password candidates read.
