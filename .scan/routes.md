# routes area — bug hunt (worktree agent-a181e7a23f39dc942, branch worktree-agent-a181e7a23f39dc942)

## RESUME
- Started 21-10-2026 on main @ cebdd0b.
- Driver: .scan/route-driver.ts (copy into <worktree>/.scratch/, run `node --experimental-strip-types --no-warnings .scratch/route-driver.ts get|post|all [pageLimit]`). Builds .scratch/base.sqlite once via simulateHousehold (22s), copies per batch.
- Status: GET crawl running (ravi, priya, anil, meera(removed), anon, + ravi with features off/demo/adminDebug). Next: triage findings-get.jsonl, then post phase.
- Note: 404-on-real heuristic noisy (bogus ids like 0/-1/%3C); /settings/password 404 is deliberate when password sign-in off.

## Coverage

## Findings
| ID | Sev | Request | Root cause | Status |
|---|---|---|---|---|
