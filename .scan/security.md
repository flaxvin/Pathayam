# Security audit (area=security)
## RESUME
- Branch: worktree-agent-a328b55d05efe9efb. Started 2026-10-21.
- Status: reading code. No findings yet.

## Findings
1. MEDIUM — Reinstating a removed member revives their API tokens. Repro: mint token, removeMember, inviteMember same email, GET /settings with Bearer → 200. Root: removeMember revoked sessions only; token gate read allow-list live. Fix: removeMember revokes api_tokens. Test src/web/removed-member-tokens.test.ts. Status: fixed, uncommitted (pending full suite).
2. MEDIUM — Gmail routes during impersonation mix identities. Read-only view: GET /gmail/connect + /gmail/callback overwrite viewed member's gmail_connections row with viewer's refresh token. Writes on: /gmail/fetch uses viewed member's refresh token (reads their mailbox); /gmail/disconnect deletes viewed member's link and revokes viewer's at Google. Fix: refuse all 4 while impersonating (403). Test src/web/impersonation-gmail.test.ts. Status: fixed, uncommitted.
3. MEDIUM — Whole body (12 MB) buffered before auth (open lead, confirmed). Repro: anonymous POST /transactions declaring 12MB, send 1KB → server waits (no response). Fix: server reads body after middleware; readBody refuses declared Content-Length > cap up front; public paths capped at 64 KB via ctx.locals.bodyLimit. Test src/web/body-before-auth.test.ts. Status: fixed, uncommitted.
4. LOW — POST /signout refused (403) during read-only impersonation. Fix: add /signout to IMPERSONATION_CONTROLS. Test src/web/impersonation-signout.test.ts. Status: fixed, uncommitted.
- Lead "idempotency keys household-wide": NOT reproduced — idempotency_keys PK is (key, member_id); undoByIdempotencyKey (household-wide events lookup) has no route caller.
- Sound: token deny-list segment match, CSRF origin middleware, safePath, attachments mime+nosniff, csvCell formula guard, OIDC iss/aud/PKCE, sessions hashed + absolute expiry, export per-member.
