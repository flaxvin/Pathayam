# ui-quality audit notes
## RESUME
- Worktree: /home/user/Pathayam/.claude/worktrees/agent-ac27d537fa661e002 (branch worktree-agent-ac27d537fa661e002, base cebdd0b)
- Server: DEMO_MODE=1 DATABASE_PATH=<wt>/.scratch/demo.sqlite PORT=8208 node dist/main.js (rebuild dist after src edits: npm run build)
- Driver: .scan/ui-quality-driver/audit.mjs (crawler, `node audit.mjs <Member> out.json [max]`, COMBOS env), summarize.mjs, probe.mjs; playwright-core in <wt>/.scratch/node_modules
- Done: Ravi 375x812 light crawl (139 page templates). Fixes UIQ-1..3 written, full npm test running, NOT yet committed.
- Next: commit UIQ-1..3 separately + format-patch; crawl Ravi dark/desktop, Priya, Anil; tap-target decision; PWA/manifest/cache checks; theme toggle in system mode.
## Findings
- UIQ-1 (medium) /explain/ready-to-assign and /explain/category/:id opened directly (new tab/long-press/no JS) render raw HTML tags as text: fragment starts with "\n", server.ts isHtml check fails -> text/plain. Also lone " · " lines. Fix: navigation gets full page with h1, dialog fetch sends X-Fragment:1. Screenshot screens/ui-quality/explain-375-light.png. Status: fixed, uncommitted.
- UIQ-2 (low) charts.ts emits svg height="auto" -> console error on /overview, /reports, /schedules, /net-worth etc. Fix: style height:auto. Status: fixed, uncommitted.
- UIQ-3 (low/a11y) /schedules: every schedule's edit form repeats ids split_category_0.. (label for= hits wrong form). Fix: idPrefix in renderCategoryLines. Status: fixed, uncommitted.
- Candidates to verify: button-small 34px tap targets on phone (docs claim 44px) -> systemic; header theme toggle 33x34, member link 54x34, scope pills x34; checkboxes 13x13 on / and /add; nameless buttons on /review,/schedules,/goals,/accounts/:id; net-worth nameless account links; chip-warning contrast 3.32 in register (light); /tax h1->h3; brand link nameless 24x24.
