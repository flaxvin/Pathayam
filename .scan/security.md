## RESUME
Worktree: /home/user/Pathayam/.claude/worktrees/agent-af245fc03bc1daf46, branch worktree-agent-af245fc03bc1daf46, base b9a17a3.
D2 done (4527f52). Next: D3 (Host vs BASE_URL in sameOriginWrites, src/app.ts ~469/1004).
Plan D3: harness sets config.baseUrl to real port after listen when not overridden; accept Host == BASE_URL host:port, or both loopback w/ same port; else 403 on unsafe methods.
Full suite takes ~9 min (2207 after D2).

## Log
- D2: removeMember deletes member_passwords row; invite msg for reinstated; departure page line; docs/security.md Passwords bullet. Test src/web/removed-member-password.test.ts. Patch 0001.
