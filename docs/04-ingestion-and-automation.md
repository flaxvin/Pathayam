# 04 · Ingestion & Automation

**Draft v0.1 · 26-08-2026.** Functional behaviour of getting transactions in and categorising them without typing.

---

## 1. The call

**Ship manual + CSV/PDF import first, add email/SMS alert parsing second, and treat Account Aggregator as an optional adapter that may never be built.** Every path terminates in the same **review queue** and the same **rules engine**, so adding a source later changes nothing downstream.

Three supports:

1. **The review queue is the architecture.** One staging area, one dedupe pass, one rules pass, one human confirmation. Sources are interchangeable plugins in front of it. Get this right in P0 and P1/P3 are additive, not rewrites.
2. **Email/SMS parsing is the only automation that works across all Indian banks without a regulated integration.** Every Indian bank sends transaction alerts. No aggregator covers the long tail reliably at household scale [inferred].
3. **Account Aggregator is regulated infrastructure with an unresolved eligibility question for a personal app.** It is the right answer if it is open to you and a dead end if it is not — so it must never be on the critical path. See §5.

---

## 2. The pipeline

Every transaction, from every source, follows the same path:

```
Source adapter
   ↓  produces a raw record: date, amount, direction, narration, account hint, source, source-id
Normalisation
   ↓  parse amount and date, determine direction, resolve target account
Dedupe check                        → suspected duplicate? → Review §4
   ↓
Rules engine (pre → default → post) → produces payee, category, memo, tags, flags
   ↓
Auto-approve gate                   → rule said auto-approve AND confidence high? → Ledger
   ↓
Review queue                        → human confirms → Ledger
                                    → human corrects → Ledger + proposed rule
```

**Invariants:**

- I1 The raw record is retained forever, unchanged, alongside the final transaction (P4).
- I2 Nothing enters the ledger from an automated source without either human confirmation or an explicit auto-approve rule the human created.
- I3 Every import is a batch with an id, a log, and a single-action undo (F13.6).
- I4 A suspected duplicate is never silently dropped (N3).
- I5 Re-running an import of the same file is idempotent — it produces zero new transactions and zero new review items.

---

## 3. Source adapters

### 3.1 Manual entry — P0

The baseline that must always work, offline (F4, S3). Not a fallback: for cash spending it is the only source.

### 3.2 CSV / XLSX import — P0

- A **mapping profile** per bank+account: which column is date, narration, debit, credit or signed amount, balance, reference; date format; decimal and thousands separators; rows to skip; encoding.
- Profiles are saved, named, auto-detected on subsequent imports by header signature.
- The mapping UI shows the raw rows throughout; an unrecognised file is a mapping task, not an error.
- Must handle: separate debit/credit columns, single signed amount column, amounts with embedded commas in Indian grouping, `Cr`/`Dr` suffixes, trailing balance columns, footer rows, multi-line narration, and files where the header is not row 1.
- Output: raw records tagged with source `csv`, batch id, and row number.

### 3.3 PDF statement import — P0/P1

Indian banks hand out PDF statements more readily than CSV. Functionally:

- Extract a table from the PDF, present the extracted rows exactly as parsed for confirmation.
- Password-protected statements must accept a password at import time and must not store it.
- Confidence per row; low-confidence rows are highlighted rather than dropped.
- The user can correct a cell in the preview before import.
- **Scope guard:** support the household's actual banks properly rather than attempting universal PDF support. Add banks on demand.
- **P0 parser scope, confirmed 26-08-2026 (Q2): HDFC Bank, ICICI Bank, Axis Bank and SBI** — bank accounts and their credit cards, which carry the bulk of the transaction volume. Union Bank, YES Bank, IndusInd, Canara, RBL and HSBC fall back to generic CSV mapping or manual entry, and get profiles on demand. Full institution list: `09-decisions-log.md` §2.
- **The CDSL Consolidated Account Statement is a P1 parser** covering every mutual fund folio and demat holding in one monthly password-protected PDF (`07` F19.14). Its rows reconcile against existing holdings rather than duplicating them.

### 3.4 Email alert parsing — P1

Bank transaction alert emails are structured enough to parse and arrive within seconds of a spend.

- Connect a Gmail account (read-only scope, one member's mailbox at a time).
- Match candidate emails by sender domain + subject patterns per bank, configured as **parser profiles** the same way CSV profiles work.
- Extract: amount, direction, date/time, account last-four, merchant/VPA, reference number, card last-four.
- **Add-on card resolution:** an alert naming an add-on's last four MUST resolve to that add-on card on the primary's Credit account, and MUST default the transaction's owner to the add-on holder (`09` §4, R6.e). Alerts for a household member's add-on routinely arrive in the primary holder's inbox.
- Produce raw records tagged `email`, with the message id as source-id (guarantees I5).
- Every parsed alert lands in Review. Nothing auto-posts until the user has approved that parser profile's output enough times to trust it.
- **Privacy constraints:** read-only scope; only messages matching configured bank senders are ever read; message bodies are not retained beyond the extracted fields plus the raw narration; the connection is revocable and revocation deletes stored tokens.

### 3.5 SMS alert parsing — P1/P2

Higher coverage than email in India, but only reachable from a device.

- Functionally: an Android companion (or a shortcut/automation) forwards matching SMS bodies to the app; the app parses them with the same profile mechanism.
- iOS cannot read SMS; iOS households fall back to email parsing and manual entry. This is a hard platform limit, not a gap to close.
- Same output shape, tagged `sms`.
- **Constraint:** SMS alerts frequently lack a merchant name (`UPI/DR/431/…`) and often lack the counterparty entirely. These arrive as amount+account+time records needing a payee, which is exactly what the review queue is for.

### 3.6 UPI narration parsing — P1, cross-cutting

Not a source; a normalisation step applied to narration from every source.

Indian narration strings carry structure worth extracting into named fields the rules engine can match on (F6.9):

- **Channel** — UPI, IMPS, NEFT, RTGS, POS, ATM, ECS/NACH, EMI, ACH-DB
- **Direction token** — DR/CR
- **VPA** — `name@bank`
- **Merchant token** — the merchant string, frequently `MERCHANT*SUBMERCHANT` or with a trailing order id
- **Reference number** — the 12-digit UPI RRN or bank reference
- **Counterparty bank / handle**

Extracted fields are stored on the raw record and exposed as rule condition targets. A rule can then say *"if VPA domain is `@ybl` and merchant token contains `SWIGGY` → payee Swiggy, category Eating Out"* without regex over the whole string.

**Payee cleanup heuristics** (all proposals, never silent — N9): strip reference numbers and order ids; collapse `MERCHANT*ANYTHING` to `MERCHANT`; title-case ALL-CAPS merchant strings; map known VPAs to known payees; treat a first-time VPA as a new payee proposal, not an auto-created payee.

### 3.7 Account Aggregator — P3, optional

See §5. Built as one more adapter producing the same raw records. Nothing downstream changes.

### 3.8 API / webhook inbound — P2

A documented inbound endpoint accepting a raw record, so a self-hosting household can wire anything (a scraper, a Tasker rule, a Home Assistant automation) into the same pipeline. Same review queue, same rules, same dedupe.

---

## 4. Duplicate detection

Duplicates are the failure mode that destroys trust fastest, and they are guaranteed here: the same ₹450 Swiggy order can arrive as an SMS alert, an email alert, and a line in the month-end statement.

**Match tiers:**

| Tier | Condition | Action |
|---|---|---|
| **Exact** | Same source and same source-id already imported | Silently skip (this is I5 idempotency, not a duplicate) |
| **Strong** | Same account, same amount, and same bank reference number | Auto-link as the same transaction; upgrade the existing record with any richer fields from the new source; log it, do not queue it |
| **Probable** | Same account, same amount, date within ±3 days, and normalised payee matches | Queue as suspected duplicate with both records shown side by side and the match reason stated |
| **Weak** | Same account, same amount, date within ±1 day, no payee match | Queue as suspected duplicate, lower prominence |
| **Manual-vs-imported** | A manually entered transaction matches an imported one on account + amount within ±5 days | Queue, and default the suggested action to *merge, keeping the manual category and the imported payee/reference* |

**Rules:**

- D1 The user's choice on a suspected pair is remembered as a hint for that payee+amount pattern.
- D2 Two genuinely separate identical transactions must be easy to keep — one tap, no friction (H5: two people, same shop, same amount, same day is normal).
- D3 Merging must preserve both raw records (P4) and must be reversible.
- D4 A statement import arriving after alert-based records must upgrade them (adding reference numbers, cleared status) rather than duplicating them. This is the single most important dedupe behaviour once P1 ships.
- D5 Marking a transaction cleared via statement import is how `cleared` gets set at scale; alert-sourced records start uncleared.

---

## 5. Account Aggregator — reality check

[verified via Setu, 26-08-2026, unless marked]

**What it gives you.** Consent-based access to profile data (name, DOB, PAN), summary data (account balances) and transaction data (bank statements) across banks, NBFCs, insurers, investment funds, ETFs, SIPs and mutual fund houses. The user approves or rejects each request in their AA app with PIN authentication and can revoke at any time. The consent artefact fixes both the **duration of storage** and the **frequency of access**.

**What it costs you.** The data consumer is a **Financial Information User (FIU)**, which requires onboarding through an AA-TSP such as Setu, Finvu or Onemoney, and completion of their licensing steps. The vendor's positioning — *"we handle regulatory needs"* — implies an organisational relationship, not a self-service signup.

**The unresolved question.** Whether a personal, non-commercial, self-hosted household app can become an FIU is **not addressed by the source** and should be treated as a blocker until answered. [unverified] The framework was designed for regulated entities in lending, wealth and insurance; an individual is normally the *customer* of an FIU, not an FIU.

**Design consequence — the important part.** Because eligibility is unresolved, AA must be:

- **Optional.** The app is fully functional without it, forever.
- **An adapter.** It produces the same raw records as CSV. If it is never built, nothing else changes.
- **Fetch-frequency aware.** A consent may permit, say, daily fetches. The adapter must respect the granted frequency and must show the user the consent's terms, expiry and remaining validity in-app.
- **Storage-duration aware.** If the consent limits retention, the adapter must surface that constraint rather than silently violating it.
- **Revocation-safe.** Consent revoked in the AA app must not corrupt or delete already-imported transactions; it stops future fetches only.

**Recommendation:** do not build P3 until you have a written answer on FIU eligibility for a personal deployment. **Strongest alternative:** skip AA permanently and invest the same effort in broadening PDF/email parser profiles — coverage is comparable for a single household, with zero regulatory surface.

---

## 6. Rules engine — functional specification

Design taken from Actual Budget (`01` §3), extended for Indian narration.

### 6.1 Conditions

**Fields:** raw narration, extracted channel, extracted VPA, extracted merchant token, extracted reference, imported payee, cleaned payee, account, amount, absolute amount, direction, date, day of month, memo, existing tags, existing category, cleared state, source, card last-four.

**Operators:** is · is not · contains · does not contain · starts with · ends with · matches regex · one of · not one of · greater than · less than · between.

**Combination:** all-of / any-of, with one level of nesting. No deeper — complexity here is a usability tax with no payoff.

### 6.2 Actions

Set category · set payee · set/prepend/append memo · add tag · remove tag · set owner · set cleared · set account · set date · set amount · split into fixed amounts or percentages · mark for review · mark auto-approvable · ignore (never import).

### 6.3 Execution

- R-E1 Three ordered stages: `pre` → `default` → `post`.
- R-E2 Within a stage, rules are auto-ordered least-specific to most-specific, so a broad cleanup rule runs before a narrow override. Users do not hand-order rules.
- R-E3 Use `pre` for narration cleanup and payee normalisation, `default` for categorisation, `post` for tagging, splitting and approval flags. This convention is documented in the UI.
- R-E4 Every rule that touched a transaction is recorded on it and shown in the details pane (F6.8).
- R-E5 A rule can be tested against historical transactions before saving, with a before/after preview and a match count (F6.7).
- R-E6 A rule can be applied retroactively to matching existing transactions, with a count and confirmation (F6.6).

### 6.4 Rule learning

- L1 Renaming an imported payee proposes a `pre`-stage rule mapping that raw string to the clean payee.
- L2 Categorising a transaction from a payee for the **second** time proposes a `default`-stage rule for that payee. Once is coincidence; twice is a pattern.
- L3 Proposals appear in the Review queue (S4 §7), never auto-applied (P3, N2).
- L4 Learning is disableable per payee and globally.
- L5 Dismissing a proposal suppresses that specific proposal permanently.

### 6.5 Auto-approval

Imported transactions bypass the review queue only when **all** hold:

- A rule explicitly marked the transaction auto-approvable, **and**
- The payee resolved to an existing payee, **and**
- A category was set, **and**
- No duplicate was suspected.

Auto-approved transactions are still listed in the import log and are visually marked in the register for their first 7 days. Auto-approval is off by default and is earned per payee, not granted globally.

---

## 7. Categorisation suggestions

Where rules do not fire, the app **suggests** — it never decides (N9).

- Suggestion sources, in priority order: exact payee history → normalised merchant-token history → VPA history → similar-amount-and-day-of-month pattern → category of the most recent transaction with a similar narration.
- Suggestions display their reason: *"You've put Swiggy in Eating Out 14 times"*.
- Confidence is shown as a simple high/medium/low chip, not a percentage.
- **No opaque ML model in P0–P2.** Frequency heuristics over the household's own history are more accurate, fully explainable, and need no training data or external service. Revisit only if heuristics demonstrably fail.

---

## 8. Import log & undo

- IL1 Every batch records: source, adapter, timestamp, member, file name or mailbox, rows read, records created, duplicates found, auto-approved, errors.
- IL2 A batch can be undone in one action within 30 days, removing only records that batch created and that have not since been edited; edited records are listed and left alone with an explanation.
- IL3 Parse errors are shown with the offending raw row, never swallowed.
- IL4 The log is exportable.

---

## 9. Phasing

| Phase | Sources | Automation |
|---|---|---|
| **P0** | Manual entry, CSV/XLSX with mapping profiles, PDF for household banks | Rules engine (all three stages), dedupe tiers, review queue, import log + undo |
| **P1** | Gmail alert parsing, UPI narration extraction | Rule learning, categorisation suggestions, schedule detection, auto-approval |
| **P2** | SMS forwarding (Android), inbound API/webhook | Auto-approval maturity, per-payee trust, bulk review ergonomics |
| **P3** | Account Aggregator adapter — **only if FIU eligibility is confirmed** | Consent-aware scheduling, in-app consent status |

---

## 10. Privacy & data-handling requirements

- PR1 No transaction data leaves the household's own deployment. No third-party analytics, no crash reporting containing financial data, no external categorisation service.
- PR2 Gmail access is read-only, scoped to matching bank senders, revocable in-app, and revocation deletes stored tokens immediately.
- PR3 Email bodies and SMS bodies are retained only as the extracted raw narration plus the extracted fields. Full message bodies are not stored.
- PR4 Attachments (receipt photos) are stored in the deployment's own storage and are never cached on device by default (PWA3).
- PR5 Statement passwords are used in-memory for a single import and never persisted.
- PR6 The complete dataset is exportable and deletable by the household in one action (F15).
- PR7 If this is ever opened beyond the household, DPDP Act 2023 obligations — notice, consent, purpose limitation, breach reporting, and data-fiduciary duties — become live and must be designed in before, not after. [unverified as to specific applicability thresholds; take legal advice before any public deployment.]
