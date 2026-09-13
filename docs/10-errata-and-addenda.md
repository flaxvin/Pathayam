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

| E13 | `07` §4, §10 | Market value ₹80,874.13 · unrealised gain ₹5,874.13 · FIFO cost of units sold ₹32,218.75 · realised gain ₹2,341.25 | **The rule and the illustration disagree; the rule governs.** These figures are computed from *unrounded* units (936.043123…), as `verify_portfolio.py` does. But **R24.3 is normative** and stores derived units to three decimals — which is what a registrar actually allots, and what the household's own statement will say. At 936.043 units the figures are **₹80,874.12**, **₹5,874.12**, **₹32,218.76** and **₹2,341.24**. The paisa differences are all the same root cause. | R24.3 |

| E14 | `09` R6.n | "Say who is **ahead** or **behind**" | **Superseded by R6.n.1.** Those words describe a *person*, so one balance read "₹36,640 ahead" in a table and "the household is ₹36,640 behind with Ravi" two inches below — one fact from two subjects, which reads as a bug. Every sentence now takes **the commitment** as its subject and uses the budget screen's own words: **underfunded** and **overfunded**. R6.n's ban on the language of debt, and its three endings, stand unchanged. | Built, then used |
| E15 | `15` §4A.5 | "*Gifts and treats* is the obvious default and the household can pick another." | **Superseded by R6.s.** Agreeing to leave a lopsided month is usually not a present, and naming it one attributes a generosity neither person claimed. The default is **Settled between us**, and the giving budget's other envelopes are offered at the moment of the act rather than afterwards. | Built, then read aloud |
| E16 | `14` §4.3 | "**Total** 12–20 weeks" for per-individual budgets | **Superseded twice.** `15`'s design found the engine's arithmetic does not change at all, moving it to 12–17 weeks; `16` planned it at 17 and it is now built (P0–P6). The note in `14` §4.3 already says the estimate predates the design; this records where it landed. | `15`, `16` |

**E12 was found by `verify_docs.py`** (§3.4), on its first run, in a line ten manual passes had missed. That is the argument for building it.

**E14 and E15 were found by using what had been built**, which is the only way that
class of error surfaces: both were defensible on the page and wrong on the screen.

**E13 was found by implementing R24.3 and failing to reproduce §10.** Worth stating why the rule wins: at NAV 82.50, ₹25,000 buys 303.030 units, not 303.0303…, so those units cost fractionally more than the NAV each. Pro-rating what was actually paid — rather than recomputing units × NAV — is also the only convention under which **selling a holding entirely realises exactly the gain that was showing as unrealised the moment before**. A user would notice that contradiction; they will not notice a paisa.

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

- A second NAV adapter SHOULD exist behind the same provider interface (`07` P1, P2), reading **AMFI's own published daily NAV file** and matching on ISIN. [**verified 27-08-2026** — `https://www.amfiindia.com/spages/NAVAll.txt`, 200, ~1.5 MB, semicolon-delimited: `Scheme Code;ISIN Div Payout/ISIN Growth;ISIN Div Reinvestment;Scheme Name;Plan;Option;Net Asset Value;Date`, with dates as `DD-Mmm-YYYY`. Two things the format forces on the adapter: a scheme carries **two** ISINs, growth/payout and reinvestment, and a holding may be identified by either; and rows are not all current — the live file contains rows dated years back, so R26.2's published date must be carried through rather than stamped with the fetch date.]
- Until it exists, an MFAPI outage degrades to cached prices with staleness shown (FW9) and manual entry (R26.6) — annoying, never data-losing. This addendum is about not staying degraded.

### 3.4 Suggestion — `verify_docs.py` *(not adopted; a recommendation in the spirit of `verify_amortisation.py`)*

The errata in §2 are exactly the class of defect a 30-line script catches: normative sentences containing withdrawn tokens. Proposed check, run beside the two existing verify scripts: fail on `offline`, `PWA[0-9]`, `push`, `service worker`, `localStorage`, `IndexedDB` appearing in a MUST/SHOULD sentence outside an explicit MUST-NOT or withdrawal context, and fail on any reference to a withdrawn rule id (PWA1–PWA10, R35.6, F21.7). False positives are resolved by an allow-list comment, the same way the rupee figures are pinned today. **Recommendation: build it before the next doc revision. Strongest alternative:** rely on `09` + this file as the sole authorities and never patch — cheaper, but §2 is the evidence that readers do follow the stale line.

---

### 3.5 F2.10 — private lending within the family *(extends `02` F2, `06`)*

*Raised 28-08-2026.* Money lent to or borrowed from family and friends is a real
and recurring part of this household's finances, and the document set has
nowhere to put it. Both existing homes are wrong:

- **As a loan (`06`)** — the machinery does not fit. There is usually no
  interest rate, no EMI, no amortisation schedule, and no lender statement, so
  R18.8's drift measurement has nothing to measure against and R15–R17's
  interest models have nothing to model. Forcing an interest rate of zero to
  make the screens render is how a module becomes a lie.
- **As a Tracking account (F2.4 "other asset" / "other liability")** — the
  balance is a number the household retypes, untethered from the events that
  created it. That loses exactly what they want to know: *what is outstanding,
  since when, and what has been repaid.*

**F2.10 The app MUST support a `family-loan` Tracking subtype**, for money lent
to or borrowed from a person rather than an institution.

- FL1 A family loan MUST record a **counterparty** (a name, not a member — the
  other side is usually not in the household) and a **direction**: money *lent*
  is an asset, money *borrowed* is a liability.
- FL2 The balance MUST be **derived from dated advances and repayments**, never
  typed. This is the whole difference from a Tracking account, and the reason
  the subtype exists.
- FL3 An advance or repayment MUST be recordable as a **transfer from or to a
  Budget account**, so the cash side is real: lending ₹50,000 reduces a bank
  balance, and R1's "Ready to Assign is money you have" stays true.
- FL4 An advance MUST NOT be spending and a repayment MUST NOT be income.
  Lending money does not consume an envelope, and being repaid is not earnings.
  Both are transfers; only a **written-off** balance is an expense (FL7).
- FL5 Interest is **optional and simple**, expressed as an agreed total rather
  than a rate, because that is how these arrangements are actually made
  ("give me back ₹55,000"). The app MUST NOT compute an amortisation schedule
  for a family loan.
- FL6 A family loan MUST expose, without being asked: the outstanding balance,
  the date of the original advance, the date and amount of the last repayment,
  and how long it has been outstanding. **N18 applies with force** — the app
  states how long, and says nothing about it.
- FL7 A balance MUST be **write-off-able** in one action, as a dated expense to
  a category the household chooses, with the original advances retained (P4).
  Writing off is the honest end state for a loan that will not be repaid, and an
  app that cannot express it forces the household to lie or to delete history.
- FL8 A family loan MUST count in net worth under R29.4's existing groups — lent
  money as an asset, borrowed money as a liability — and MUST NOT appear on the
  budget screen (FW3).
- FL9 No reminder, no nudge, no ageing alert. `02` N18 forbids the app being
  used to apply pressure, and the person on the other side of a family loan is
  not a debtor to be managed.

**Priority: P1.** It is a small module — no schedule, no interest engine, no
provider — and its absence is felt every month.

---

### 3.6 PR5 reversed, deliberately — statement password derivation *(extends `04` PR5, §3.4)*

*Decided 28-08-2026.* **PR5 as written cannot coexist with unattended statement
fetching**, and this records the choice rather than letting the code quietly
make it.

PR5 says: *"Statement passwords are used in-memory for a single import and never
persisted."* That is correct for a household that uploads a file and types a
password. It is impossible for `04` §3.4's Gmail path, where nobody is present
to type anything.

**Why the app cannot simply not store a password.** Indian banks do not let you
choose one. Each derives it from something they already know, and every
institution picks differently — verified from the emails themselves:

| Institution | Its own words |
|---|---|
| Union Bank of India | "first four characters of your name in uppercase followed by Date/Month(DDMM) of your birth" — *RAVI0101* |
| Axis Bank | "first four letters of your name … followed by your date and month of birth in ddmm format. The password is case sensitive (lowercase)" |
| ICICI Bank | "Enter all letters in small case without adding any special characters, spaces or salutation" |
| Upstox, INDmoney | "use your PAN (in lowercase)" |
| IndusInd | date of birth, generally DDMMYYYY |
| RBL Bank | first four letters plus DDMM**YY** — a two-digit year, found by trying |
| **SBI account** | last five of the registered mobile, then DOB as DDMMYY — *"mobile XXXXX12345 and DOB 16 Sept 1982 → 12345160982"* |
| **SBI Card** | DOB as DDMMYYYY, then the card's last four — *"DOB 01.04.1980 & card 1234 → 010419801234"* |
| **Canara** | the card's last four, alone — *"5111********5006 → 5006"* |
| **HSBC** | DOB as DDMMYY, then the card's last six |

The last four rules each need a datum the name/PAN/DOB triple does not carry —
the registered mobile, or the card number. The card's last four the app
already holds per account for SMS matching (F2.9), so Canara and SBI Card open
on the auto-fetch path with nothing extra typed; the mobile is one more
optional identity field; HSBC's last-six needs a fuller card number than the
stored last-four, so it falls back to the type-it-once path. All four are
verified in tests against the bank's own worked example, the same way Union
Bank's was.

**A statement password is usually the PDF's *owner* password.** Verified
28-08-2026: qpdf reports of a Union Bank statement that `RAVI0101` — the string
the bank's own email tells the customer to use — is the owner password, and
that the user password is an internal customer number never disclosed. A reader
that checks only the user password rejects the documented one. Both paths must
be tried.

So storing "the password" and storing "the name, the date of birth and the PAN"
are the same act. Pretending otherwise by storing only the derived string would
be *worse*: the same exposure, plus a value that silently stops working when a
bank changes its rule.

**PR5 is therefore amended:**

- PR5.1 Statement passwords supplied by hand MUST still be used in memory for a
  single import and never persisted. This is unchanged and remains the default.
- PR5.2 A household MAY **opt in** to storing the name, date of birth and PAN
  that statement passwords are derived from, solely so statements can be opened
  without a human present.
- PR5.3 These values MUST NOT appear in an export (`08` F15), in the event log
  (R37), or in any log line. Each is asserted by a test.
- PR5.4 They MUST be shown masked wherever they are displayed.
- PR5.5 The derived password MUST NOT be stored — only the ingredients.
- PR5.6 The feature MUST be removable in one action, and the app MUST work
  fully without it.

**Stored in the clear**, consistent with `08` S9. That decision declined
database encryption at rest — *"the database key must live where the app can
read it at start, so it protects against a stolen disk and little else — while
adding a key-management step that, if fumbled, loses everything"* — and chose
to encrypt the **backups** instead. Encrypting these two fields specifically
would be exactly the key-management step S9 rejected, for the same small
benefit. The containment is PR5.3's boundaries, not a cipher.

**The honest cost.** A household that opts in has moved a government identifier
and a date of birth onto the same box that holds their ledger. `08` §7's threat
model already assumes that box is trusted; this makes the consequence of it
being wrong slightly worse. That is the trade, it is opt-in, and the settings
screen states it in those terms rather than reassuring terms.

---

## 4. Precedence, restated

Where documents disagree, the order of authority is:

1. `09-decisions-log.md` — decisions
2. **This document** — corrections and the three additions above
3. `08` over `02` §9 (as already stated in `00`)
4. Everything else, newest section wins

A future closure should append to `09` and, if it strands normative text elsewhere, add a row to §2 here rather than editing history.
