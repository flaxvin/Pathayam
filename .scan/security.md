## RESUME
Worktree: /home/user/Pathayam/.claude/worktrees/agent-af245fc03bc1daf46, branch worktree-agent-af245fc03bc1daf46, base b9a17a3.
D2 done (4527f52). D3 implemented, uncommitted (addressedHere/requestHost in src/app.ts, test src/web/dns-rebinding.test.ts, docs security.md + operations.md) — full suite running; commit when green.
D4 next: test written src/web/notice-forgery.test.ts (fails 4/5 pre-fix). Plan: per-process HMAC key (randomBytes) in buildApp; withNotice adds &ns=<hmac(message)>; noticeFrom shows only valid sig, kind always success (no producer sets kind=); /portfolio/cas?error= -> fixed key error=expired.
Then: OIDC discovery timeout (503).
Full suite ~9 min.

## Log
- D2: removeMember deletes member_passwords row; invite msg for reinstated; departure page line; docs/security.md Passwords bullet. Test src/web/removed-member-password.test.ts. Patch 0001.
