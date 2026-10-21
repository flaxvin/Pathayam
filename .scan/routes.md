# routes area — bug hunt (worktree agent-a181e7a23f39dc942, branch worktree-agent-a181e7a23f39dc942)

## RESUME
- Started 21-10-2026 on main @ cebdd0b. Resumed after usage limit; wrap-up deadline ~45 min from resume.
- Driver: .scan/route-driver.ts (copy into <worktree>/.scratch/, run `node --experimental-strip-types --no-warnings .scratch/route-driver.ts get|qfuzz|post [pageLimit]`). Builds .scratch/base.sqlite once via simulateHousehold (22s), copies per batch. post phase reads .scratch/forms.json from the get phase.
- DONE: get phase (8 crawls: ravi, priya, anil, meera(removed), anon, ravi features-off/demo/adminDebug; 11,784 requests): zero 500s, zero broken-text, zero links/forms/redirects to missing routes. qfuzz phase (6,048 requests, every GET route x every query key it reads x 8 bad values, ravi+anil): zero findings except one 2.05s /export.json under heavy machine load (not reproduced yet).
- RUNNING: post phase (274 form patterns discovered; rendered + 23 fuzz values per field + dup field + JSON odd types).
- Next: triage findings-post.jsonl; reproduce each in a startTestApp test; fix.

## Findings
| ID | Sev | Request | Root cause | Status |
|---|---|---|---|---|
