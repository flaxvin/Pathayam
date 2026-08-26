# 10 · Errata & Addenda

**Status:** Adopted 26-08-2026 · **Owner:** Ravi
**Purpose:** the 26-08-2026 closures (`09-decisions-log.md`) were propagated into `08` and `09` but not swept through `01`–`05` and `07`. This document corrects the stale normative lines left behind, and adds three rules the closures made necessary. **For the specific lines named in §2, this document is the authority; the original files are left unedited so their reasoning stays readable.** `09` remains the authority on decisions.

---

## 1. The call

**Fix the ten stale lines by supersession, not by silent edit; add a recompute rule for editable history, a dead-man's switch for backups, and an AMFI fallback for MFAPI.**

Three supports:

1. **Stale MUSTs are executable defects, not typos.** These documents will be read by whoever (or whatever) builds the app. `02` F1.8 still says the app "MUST function fully offline" — an agent following it would rebuild the entire subsystem R35 deleted.
2. **Two of the closures created obligations nothing yet specifies.** Q5 (editable history) requires a forward-recompute semantics that no rule states; Q24 (webhook-only backup alerts) cannot report the one failure mode where the box itself is down.
3. **Supersession keeps the record honest.** The doc set's own convention (`00` §Reversals) is that changed decisions stay readable. Same treatment here: each stale line is named, the correction stated, the decision that caused it cited.

---

## 2. Errata — lines superseded by the 26-08-2026 closures

Each row names the stale text, the correcting text that now governs, and the closure responsible.

| # | Location | Stale text | Correction | Cause |
|---|---|---|---|---|
| E1 | `02` F1.8 | "The app MUST function fully offline for an already-authenticated member (P6)." | **Withdrawn.** The app requires connectivity for all reads and writes (`08` R35). Session persistence across restarts is F1.7 and stands. | R35 (server-only reversal) |
| E2 | `02` N8 | "Never: require the server to be reachable in order to record a spend." | **Withdrawn — this is now precisely the design.** The surviving guarantees are N5 (typed input is never lost) and R36.7 (saved / still trying / failed, never ambiguity). | R35 |
| E3 | `02` F16.2 | "…MUST be usable offline against locally cached data." | Reads: "Search MUST support amount ranges and date ranges in the query." No client cache exists (R35.2). | R35 |
| E4 | `03` S3 | "**Save** commits locally and closes immediately; sync happens behind it (PWA2)." | Reads: "**Save** sends the entry with its idempotency key and closes on server acknowledgement — under 400ms on a home network (`08` F21). On failure the typed input stays on screen (R36.7)." PWA2 is withdrawn. | R35, R36 |
| E5 | `03` J4 | "Push or in-app badge: *'Eating out is over by ₹1,850'*…" | Reads: "In-app badge or digest: …". There is no push (Q21), and an amount would have violated N18 regardless. | Q21 |
| E6 | `04` §3.1 | "The baseline that must always work, offline (F4, S3)." | Reads: "The baseline that must always work. Not a fallback: for cash spending it is the only source. Like every write, it requires connectivity (`08` R35, §3.3)." | R35 |
| E7 | `04` PR4 | "…never cached on device **by default** (PWA3)." | Reads: "…never stored on the device (`08` R35)." Absolute, not a default; PWA3 is withdrawn. | R35, Q10 |
| E8 | `05` §5, §7, §8 | "Q15 makes R30 the module's acceptance test" · "enforced as an acceptance test (Q15)" · "the R30 firewall as a set of assertions that fail the build" | **Q15 was declined** (`09` §3, §7). R30 is a documented invariant and a review-checklist item, not a build gate. `05` §8's asset build order starts with the holdings engine, not with firewall assertions. The residual risk is accepted and recorded in `09` §7. | Q15 |
| E9 | `05` §2 | Loans in P2 (parts 1–2); CAS import in P3 ("Assets, part 3") | **`09` §8 supersedes `05`'s phasing where they differ:** the three single-disbursement loans and CDSL CAS import are **P1**. (Also: "Attachments / receipt capture at scale" is listed twice in P3 — a duplicate, not two scopes.) | Q11, Q17 |
| E10 | `07` F19.14 | "The app SHOULD support importing a holdings statement… **[P3 — see §12 Q17.]**" | Reads: "The app **MUST** support importing the CDSL CAS as a batch of lots through the review queue. **P1.**" `07` §12 already records the upgrade; the requirement line now matches it. | Q17 |
| E11 | `01` §13 | Refused: "Investment, insurance and net-worth tracking." | Investment and net-worth tracking were brought into scope 26-08-2026, contained by R30 (`05` §5, `07`). Insurance policy tracking remains refused. The rest of the row's reasoning — why this is dangerous — is exactly why R30 exists. | Net-worth reversal |
| E12 | `02` F14.3 | "Notifications MUST degrade gracefully where the platform cannot deliver push (§9): in-app badge and a digest on next open MUST always work." | Reads: "The in-app badge and the digest on next open are the only notification channels, on every platform. Backup failures additionally fire an outbound webhook (R40.4), and a successful verified restore pings an external heartbeat (R40.8)." The conditional implied push still exists somewhere; it does not exist anywhere (Q21). `09` §6.1 corrected F14.1 but left F14.3 standing. | Q21 |

**E12 was found by `verify_docs.py`** (§3.4), on its first run, in a line ten manual passes had missed. That is the argument for building it.

---

## 3. Additions

### 3.1 R7.g — forward recompute on past-month edits *(extends `09` §5, R7.a–R7.f)*

Q5 allows any past month to be edited; R2 and R4 make every month's Ready to Assign depend on the previous month's overspend carry. An edit in month M therefore invalidates every derived monthly figure from M to the present, and nothing previously said what happens next.

- R7.g.1 Monthly figures — RTA, category opening balances, overspend carries — are **derived values**, reproducible from the event log (`08` R37.3). They are never independently authoritative.
- R7.g.2 Any edit dated in a past month MUST trigger a forward recompute of all derived monthly figures from that month to the current month, under the household's **active overspend model** (Q1).
- R7.g.3 The recompute MUST be logged as a single event batch, attributed to the edit that caused it, so "explain this number" can show that August's RTA changed because a June assignment did.
- R7.g.4 Both overspend models' recompute paths are **P0 test cases**, sitting beside the R2 and R4 worked examples. Switching the overspend model setting is itself a full-history recompute and follows this rule.
- R7.g.5 The recompute MUST NOT alter recorded transactions or assignments — only derived figures. Checkpoint breakage is handled by R7.b–R7.f as written.

### 3.2 R40.8 — the dead-man's switch *(extends `08` R40)*

R40.4's webhook fires **from the deployment**. In the worst failure class — box down, tunnel down, backup job never ran — there is no process left to send it. The one failure Q24 said must never be silent is silent precisely when it matters most.

- R40.8.1 A **successful** verified restore (R40.2) MUST ping an external heartbeat monitor — a service outside the deployment that alerts on the *absence* of the ping, not on a message.
- R40.8.2 The alerting path therefore MUST NOT depend on any component of the deployment being alive. R40.4's webhook remains, for failures the box can still report.
- R40.8.3 The health page MUST show the last heartbeat acknowledged, beside the last verified restore (R40.3).
- R40.8.4 The monitor's expected interval MUST be the verification schedule plus slack, so a single slow run does not page anyone (`08` §12: the 2am page must be real).

### 3.3 `07` §6.2 addendum — MFAPI is a wrapper; AMFI is the fallback

MFAPI is a third-party JSON layer over AMFI's published NAVs [verified 26-08-2026], not AMFI itself; it can disappear without notice and without recourse. The mitigation is already half-built: R24.6 stores the ISIN on every holding.

- A second NAV adapter SHOULD exist behind the same provider interface (`07` P1, P2), reading **AMFI's own published daily NAV file** and matching on ISIN. [unverified — the AMFI download endpoint was not checked this session; verify the URL and format before coding the adapter, per the doc set's own convention for unverified surfaces.]
- Until it exists, an MFAPI outage degrades to cached prices with staleness shown (FW9) and manual entry (R26.6) — annoying, never data-losing. This addendum is about not staying degraded.

### 3.4 Suggestion — `verify_docs.py` *(not adopted; a recommendation in the spirit of `verify_amortisation.py`)*

The errata in §2 are exactly the class of defect a 30-line script catches: normative sentences containing withdrawn tokens. Proposed check, run beside the two existing verify scripts: fail on `offline`, `PWA[0-9]`, `push`, `service worker`, `localStorage`, `IndexedDB` appearing in a MUST/SHOULD sentence outside an explicit MUST-NOT or withdrawal context, and fail on any reference to a withdrawn rule id (PWA1–PWA10, R35.6, F21.7). False positives are resolved by an allow-list comment, the same way the rupee figures are pinned today. **Recommendation: build it before the next doc revision. Strongest alternative:** rely on `09` + this file as the sole authorities and never patch — cheaper, but §2 is the evidence that readers do follow the stale line.

---

## 4. Precedence, restated

Where documents disagree, the order of authority is:

1. `09-decisions-log.md` — decisions
2. **This document** — corrections and the three additions above
3. `08` over `02` §9 (as already stated in `00`)
4. Everything else, newest section wins

A future closure should append to `09` and, if it strands normative text elsewhere, add a row to §2 here rather than editing history.
