# ui-quality audit notes
## RESUME
- Worktree: /home/user/Pathayam/.claude/worktrees/agent-ac27d537fa661e002 (branch worktree-agent-ac27d537fa661e002, base cebdd0b)
- Server: DEMO_MODE=1 DATABASE_PATH=<wt>/.scratch/demo.sqlite PORT=8208 node dist/main.js (npm run build after src edits). Reset themes after flows: UPDATE members SET theme='system'.
- Driver: .scan/ui-quality-driver/ audit.mjs (crawler; COMBOS env), summarize.mjs, probe.mjs, flows.mjs (theme toggle, signout/back, member switch, offline). playwright-core in <wt>/.scratch/node_modules.
- Coverage done: Ravi 4 combos (556 page-visits, ~139 templates each), Priya 375 dark + 1400 light (192), Anil 375 light + 1400 dark (278). All page templates reached from nav crawl.
- Commits: UIQ-1 7a778a7, UIQ-2 db20ef0, UIQ-3 c75cd4f, UIQ-4 56ee789 (all patched). UIQ-5 written+targeted tests pass; full suite running, then commit.
- Next: commit UIQ-5, browser re-verify, final report.
## Findings
- UIQ-1 (medium) /explain/* opened directly rendered raw HTML as text/plain (fragment starts "\n", server isHtml fails). Fixed: page for navigations, fragment for X-Fragment/Sec-Fetch-Dest empty. Screenshot screens/ui-quality/explain-375-light.png. COMMITTED.
- UIQ-2 (low) charts svg height="auto" -> console error on /overview,/reports,/schedules,/net-worth. COMMITTED.
- UIQ-3 (low a11y) /schedules edit forms repeat ids split_category_0.. COMMITTED (+generic dup-id check in routes.test sweep).
- UIQ-4 (medium) theme "system" + OS dark: header toggle said "Switch to dark theme"; first press stored dark, nothing changed (palette toggle same). COMMITTED. Verified in browser: first press now -> light, persists across nav.
- UIQ-5 (low a11y) brand link nameless <=480px; /tax h1->h3; uncleared register rows opacity .75 -> warning chip 3.32:1 (light). Fix in progress.
- Verified OK: pages Cache-Control no-store; back after signout -> /signin (no private page); member switch on one device shows new member; no service worker (by design R35/F21.2) so offline = browser error page; manifest valid w/ 192/512/maskable icons served; no page >1s server (max ~500ms /months/:m/close); dates DD-MM-YYYY, ₹ Indian grouping everywhere crawled; no overflow at 375 (skip-link offscreen is intentional).
- Decision for owner: .button-small is 34px min-height (header theme toggle 33x34, member link, scope pills, Skip/Use it/No thanks/Remove) though docs/screens.md says tap targets >=44px. Recommend @media (pointer: coarse){.button-small{min-height:var(--tap)}} or correct the doc.
- Decision for owner: /assets/app.js|css served public max-age=3600 with no version in URL -> after a deploy, up to 1h of new HTML with old script/CSS. Recommend content-hash query string.
- Unverified: register shows "Uncategorised" chip on budget->card "Card payment" transfers (Ravi's account 906766c4) — maybe intended; belongs to budget auditors.
