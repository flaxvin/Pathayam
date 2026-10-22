## RESUME
DONE. All four items committed; nothing left to do. Final report sent.
Worktree: /home/user/Pathayam/.claude/worktrees/agent-af245fc03bc1daf46, branch worktree-agent-af245fc03bc1daf46, base b9a17a3.
Commits: 4527f52 (D2), a51ea49 (D3), 8863b08 (D4), a3dcc8a (OIDC timeout). Patches 0001-0004 in .scan/patches/security/. Final suite 2221/2221 green, typecheck clean.

## Log
- D2: removeMember deletes member_passwords row; invite msg for reinstated; departure page line; docs/security.md Passwords bullet. Test src/web/removed-member-password.test.ts. Patch 0001.
- D3: addressedHere/requestHost in src/app.ts; test src/web/dns-rebinding.test.ts; docs security.md + operations.md. Suite 2214 green. Patch 0002.
- D4: signed notices (ns HMAC, per-process key), kind param dropped, CAS ?error=expired; test src/web/notice-forgery.test.ts; docs security.md "Notices". Suite 2219 green. Patch 0003.
- OIDC: discover() 10s AbortController incl. body, OAuthError -> 503; tests src/auth/oidc.test.ts + src/web/oidc-timeout.test.ts; docs. Suite 2221 green. Patch 0004.
