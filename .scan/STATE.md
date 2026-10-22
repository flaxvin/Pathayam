# Owner decisions: implement the recommendations (resume from here)

Started 22-10-2026 on `claude/beautiful-gates-1nevt6` @ b9a17a3 (PR #4, open, draft).
The owner asked to "do the recommended fixes for all decisions" listed in PR #4.
This directory is the durable record; the branch is pushed after every update.

## How to resume
1. `git fetch origin && git checkout claude/beautiful-gates-1nevt6`.
2. Read each `.scan/<area>.md` RESUME block. Fixes not yet integrated are in `.scan/patches/<area>/` (`git am`).
3. Re-launch only unfinished areas, telling each to read its notes file first. Each must base on b9a17a3 or later.

## Areas
| # | Notes file | Decisions | Status |
|---|---|---|---|
| A | loans.md | D1 capitalised moratorium interest added to the outstanding on the first principal-repaying instalment (dated row, like re-anchor) | launched |
| B | security.md | D2 clear password on member removal; D3 check Host against BASE_URL before trusting it (CSRF / first-run); D4 show only server-issued notices (no free-text ?notice=); OIDC discovery fetch gets its own timeout | launched |
| C | ui.md | D5 44px tap targets on coarse pointers; D6 content-hash URLs for app.js/app.css; D8 wording: over-funded shows assigned of target, income "Arrived" message, Pay it off fills statement amount, no Undo on halves of an undone transfer, net worth uses nickname, /transfer defaults To different from From | launched |
| D | transactions.md | D7 partial edits on POST /transaction/:id keep memo and cleared when not sent (form marker for checkbox) | done |
| E | imports.md | D9a Gmail statement PDFs try card-digit passwords (SBI Card, Canara, HSBC) if confirmed; D9b batch undo reverses the statement-after-alert upgrade (batch id on its event) | launched |

## Integrated
- D7 → a9c753c
