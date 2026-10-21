# routes area — bug hunt (worktree agent-a181e7a23f39dc942, branch worktree-agent-a181e7a23f39dc942)

## RESUME
- Started 21-10-2026 on main @ cebdd0b. Resumed after usage limit.
- Driver: .scan/route-driver.ts (copy into <worktree>/.scratch/, run `node --experimental-strip-types --no-warnings .scratch/route-driver.ts get|qfuzz|post|misc`). Builds .scratch/base.sqlite via simulateHousehold (22s), copies per batch; post reads .scratch/forms.json from get.
- DONE phases: get (11,784 req, 8 crawls incl. meera(removed), anon, features-off, demo, adminDebug), qfuzz (6,048), post (23,725; 274 form patterns, rendered+23 fuzz values/field+dup+JSON odd types; plus empty/bogus bodies on the 30 POST routes with no plain form), misc (2,920; auth/gmail/session/demo/impersonate/health routes under 6 configs x anon/member, bearer read & read-write JSON on every route). Total ~44,500 requests.
- ROUTES-1 committed 623fc9c (patch 0001); ROUTES-2 committed 7bcee23 (patch 0002). typecheck + npm test 2145/2145 pass.
- STATUS: DONE. Final report sent. Unverified: /auth/oidc has no outbound timeout on discovery (a hanging IdP holds the request until undici default timeout) — not reproduced against a real slow IdP.

## Findings
| ID | Sev | Request | Root cause | Status |
|---|---|---|---|---|
| ROUTES-1 | high | POST /move from_category_id=rta (the /move form default + "Ready to Assign" quick button) -> 404 "That envelope does not exist" | handler ran requireVisibleCategory on the source before the rta branch (regression from 6efbf04) | fixed 623fc9c, src/web/move-from-rta.test.ts |
| ROUTES-2 | med | GET /auth/oidc (public) when IdP discovery fails -> 500 + request_failures row per request (health page "failed") | OAuthError from beginOidc not caught (callback had SECURITY-OPS-18 fix, start did not) | fixed 7bcee23, src/web/oidc-start-unreachable.test.ts |

## Not defects / noise
- /settings/password 404 when password sign-in off (deliberate). /auth/google 503 when unconfigured (deliberate).
- POST /portfolio/refresh 4.5s in harness (real outbound fetch blocked; bounded by EXTRA-5). /export.json 2.05s once under machine load 20.
- /tokens "undefined" text = token named "undefined" by an earlier fuzz request. /rules/dismiss empty = formaction button (driver artefact).
- /transfer renders from=to the same account by default (user must choose); refused 400 "two different accounts" — UX nit, not fixed.
