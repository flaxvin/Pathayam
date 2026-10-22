## RESUME
Worktree: /home/user/Pathayam/.claude/worktrees/agent-af245fc03bc1daf46, branch worktree-agent-af245fc03bc1daf46, base b9a17a3.
D2 done (4527f52, patch 0001). D3 done (a51ea49, patch 0002).
D4 implemented uncommitted (noticeSignature/ns in src/app.ts, CAS ?error=expired, docs/security.md "Notices", test src/web/notice-forgery.test.ts); full suite running -> commit.
OIDC timeout: tests parked in <worktree>/.scratch/oidc.test.ts.new (copy over src/auth/oidc.test.ts) and .scratch/oidc-timeout.test.ts (-> src/web/). Plan: discover(issuer, fetchImpl, {timeoutMs=10_000}) AbortController like portfolio/providers.ts getJson; OAuthError "did not answer within"; route already maps OAuthError->503.
Full suite ~9 min.

## Log
- D2: removeMember deletes member_passwords row; invite msg for reinstated; departure page line; docs/security.md Passwords bullet. Test src/web/removed-member-password.test.ts. Patch 0001.
- D3: addressedHere/requestHost in src/app.ts; test src/web/dns-rebinding.test.ts; docs security.md + operations.md. Suite 2214 green. Patch 0002.
