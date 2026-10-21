# Security audit (area=security)
## RESUME
- Branch: worktree-agent-a328b55d05efe9efb (worktree .claude/worktrees/agent-a328b55d05efe9efb), base main @ cebdd0b. Started 2026-10-21.
- Status: DONE (final). 4 fixes committed; patches in .scan/patches/security/ (each named 0001-SECURITY-RESCAN-N-*.patch, apply in order 1..4). Typecheck clean; full suite 2148/2148 pass.
- Commits: 2e1fed7 (RESCAN-1), 1b05db4 (RESCAN-2), 5c37c9d (RESCAN-3), 1b02062 (RESCAN-4). Not pushed.

## Findings
1. MEDIUM — Reinstating a removed member revives their API tokens. Repro: mint token, removeMember, inviteMember same email, GET /settings with Bearer → 200. Root: removeMember revoked sessions only; token gate read allow-list live. Fix: removeMember revokes api_tokens. Test src/web/removed-member-tokens.test.ts. Status: fixed, 2e1fed7.
2. MEDIUM — Gmail routes during impersonation mix identities. Read-only view: GET /gmail/connect + /gmail/callback overwrite viewed member's gmail_connections row with viewer's refresh token. Writes on: /gmail/fetch uses viewed member's refresh token (reads their mailbox); /gmail/disconnect deletes viewed member's link and revokes viewer's at Google. Fix: refuse all 4 while impersonating (403). Test src/web/impersonation-gmail.test.ts. Status: fixed, 1b05db4.
3. MEDIUM — Whole body (12 MB) buffered before auth (open lead, confirmed). Repro: anonymous POST /transactions declaring 12MB, send 1KB → server never answers. Fix: server reads body after middleware; readBody refuses declared Content-Length > cap up front; public paths capped at 64 KB via ctx.locals.bodyLimit. Test src/web/body-before-auth.test.ts. Status: fixed, 5c37c9d.
4. LOW — POST /signout refused (403) during read-only impersonation. Fix: add /signout to IMPERSONATION_CONTROLS. Test src/web/impersonation-signout.test.ts. Status: fixed, 1b02062.
- Lead "idempotency keys household-wide": NOT reproduced — idempotency_keys PK is (key, member_id); undoByIdempotencyKey (household-wide events lookup) has no route caller.
- Sound: token deny-list segment match, CSRF origin middleware, safePath, attachments mime allow-list + nosniff + no-store, csvCell formula guard, OIDC iss/aud/PKCE/email_verified, sessions hashed + absolute expiry, password enumeration/lockout parity, per-member exports, impersonation token minting refused, no service worker, CSP without inline script, layout escaping.

## Decisions for owner
- Reinstated member's old password still signs in (inviteMember clears removed_at only). Recommend clearing password on removal, or documenting that re-adding restores it.
- ?notice=&kind= renders arbitrary (escaped) text on any page: content spoofing via a crafted link. Recommend server-issued notices only.
- CSRF hostOrigin trusts the Host header; with DNS rebinding an anonymous page could POST /auth/first-run on a fresh LAN install with LOCAL_LOGIN before the owner does (unverified). Recommend checking Host against BASE_URL.
- OIDC sends no nonce (PKCE + back-channel exchange present). Defence in depth only.

## Unverified
- DNS-rebinding first-run (above); mfapi scheme code ".." path traversal within api.mfapi.in (same host, low).
