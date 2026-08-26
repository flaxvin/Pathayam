# 09 · Decisions Log

**Closed 26-08-2026.** Every open question from `05` §6, `07` §12 and `08` §14 is resolved here. This document is the authority; the tables in those documents point back to it.

---

## 1. What changed as a result

Five answers changed the design rather than merely confirming a default:

1. **No service worker at all.** Push is dropped (Q21), so the last reason to register one disappears. The client is now a plain installable web app with zero background machinery.
2. **CAS import is promoted from P3 to the primary holdings source** (Q17). A CDSL Consolidated Account Statement already arrives monthly covering every fund folio and demat holding — hand-entering lots was solving a problem that a parser solves better.
3. **No home loan exists** (Q11), so tranche drawdown and pre-EMI drop out of the critical path. The three real loans are all single-disbursement.
4. **Add-on cards are a new mechanic** — Priya's Axis card is an add-on on Ravi's account, not a separate card. `06` R6 did not model this. See §4.
5. **History stays editable in every past month** (Q5), which collides with reconciliation checkpoints. Resolved with a loud-breakage rule rather than a refusal. See §5.

---

## 2. The institution list, confirmed

Compiled from a 90-day Gmail scan (28-05-2026 → 26-08-2026) and confirmed by the owner.

### Bank accounts

| Bank | Account | Statement sender | P0 parser |
|---|---|---|---|
| HDFC Bank | ***6604 | `hdfcbanksmartstatement@hdfcbank.bank.in` | **Yes** |
| ICICI Bank | ****6612 | `estatement@icici.bank.in` | **Yes** |
| SBI | multi-account | `cbssbi.cas@alerts.sbi.bank.in` | **Yes** |
| Axis Bank | — | `statements@axis.bank.in` | **Yes** |
| Union Bank of India | ****6628 | `noreplyunionbank@ubi.bank.in` | Generic CSV / manual |
| IndusInd Bank | savings | notices only, no statement email | Manual |
| HSBC India | — | notification only, no attachment | Manual |

### Credit cards

| Issuer | Card | Last 4 | P0 parser |
|---|---|---|---|
| HDFC Bank | Swiggy HDFC | 4412 | **Yes** |
| ICICI Bank | Amazon Pay ICICI | 0005 | **Yes** |
| ICICI Bank | second card | 0009 | **Yes** |
| Axis Bank | Atlas | 3150 | **Yes** |
| Axis Bank | Airtel Axis Mastercard | ..26 | **Yes** |
| Axis Bank | (alerts seen) | 3178 | **Yes** |
| **Axis Bank** | **add-on card, Priya** | 3162 | **Yes** — as an add-on, see §4 |
| SBI Card | Landmark Rewards SELECT | 2204 | **Yes** |
| SBI Card | BPCL SBI Card | 2017 | **Yes** |
| YES Bank | UNI RuPay | — | Generic / manual |
| IndusInd Bank | incl. an Amex variant | 5501, 5517 | Manual |
| Canara Bank | RuPay | 512345****04 | Manual |
| RBL Bank | offers only | — | Manual |
| HSBC | notices only | — | Manual |

### Loans — all three confirmed, none with tranche disbursement

| Lender | Account | Type | Interest model | Status |
|---|---|---|---|---|
| Axis Bank | PPR****4417 | Personal loan | Confirm at entry — personal loans are often quoted flat (`06` R16 M2); the equivalent reducing rate must be shown | Disbursed 14-08-2026 |
| Union Bank of India | — | **Education loan** | Reducing balance, **M1** | **Full EMI, repayment started — moratorium over** |
| Canara Bank | ***318 | Loan | Confirm at entry | Active |

### Investments

CDSL CAS (monthly, consolidated) · INDmoney / INDstocks (weekly) · Upstox (weekly + monthly + quarterly demat) · SBI Mutual Fund folio ****401 via CAMS · Franklin Templeton folio ****418 via CAMS · NPS via Protean (monthly) · SafeGold (monthly) · Gullak (monthly)

### Wallets and rails

Paytm (monthly statement) · Amazon Pay (balance, autopay, bill reminders) · CRED (card bill payments)

---

## 3. All decisions

### Core engine

| # | Question | **Decision** | Effect |
|---|---|---|---|
| Q1 | Overspend model | **Ship both.** Actual's model (overage reduces next month's RTA) as default; YNAB-style carry-the-negative as a household setting | `02` R4 already anticipated this. Both paths must be implemented and tested in P0 — the setting is not a stub. |
| Q2 | P0 statement parsers | **HDFC · ICICI · Axis · SBI** — accounts and cards | Everything else falls back to generic CSV or manual. Add banks on demand. |
| Q3 | Priya co-user | **Yes, from day one** | H1–H6 are P0. Attribution, ownership and impersonation all ship with the core. |
| Q5 | Past-month assignments | **Any past month, always editable** | Overrides the `02` R7 default. Requires the checkpoint-breakage rule in §5. |
| Q6 | Auto-assign at rollover | **Off by default**, opt-in with preview | `02` R13.5 confirmed. The monthly sit-down stays a deliberate act. |
| Q7 | Cash | **A real Budget account.** ATM withdrawals are transfers; cash spends are categorised | `02` L8 confirmed and strengthened. |
| Q9 | Auto-assign templates | **Form-only in P0**, text syntax in P2 | `02` R9 confirmed. The form is the product; text is an escape hatch. |
| Q10 | Receipt attachments | **In scope** | Reverses the P3 default. See §6 for the server-only implications. |

### Loans

| # | Question | **Decision** | Effect |
|---|---|---|---|
| Q4 | Card EMI conversion | *(answered earlier)* Credit-card EMI is a first-class loan type | `06` §7.4 |
| Q11 | Which loans | **Three: Axis personal, Union Bank education, Canara.** No home loan | **Tranche drawdown and pre-EMI (`06` R15, §7.1) move to P3.** Build the model, seed no data. |
| Q11b | Education loan lifecycle | **Full EMI, repayment started** | Moratorium models M3/M4 are not needed for real data. Still built — an education loan that has already exited moratorium is the simplest case (M1). |
| Q12 | Principal/interest split | **Accept projection, reconcile quarterly.** Drift threshold ₹500 | `06` R18 confirmed. Estimated splits stay visually marked until confirmed (R18.3). |
| Q13 | FY interest report | **Yes** — interest and principal per Apr–Mar year, across all three loans | Report only. No tax computed (`02` L14, N15). |
| Q14 | Standalone prepayment calculator | **Yes** — usable before any loan exists | `06` R19.7 extended: seedable from an existing loan or from scratch. |

### Assets, net worth and currency

| # | Question | **Decision** | Effect |
|---|---|---|---|
| Q15 | R30 firewall as a build-blocking test | **Not adopted as a build blocker** | R30 remains a documented design invariant and a review-checklist item, not an automated gate. Noted as a risk in §7. |
| Q16 | Direct equities | **Mostly mutual funds, few or no direct stocks** | **Alpha Vantage becomes near-optional.** MFAPI covers the portfolio and consumes no quota. See §6. |
| Q17 | CAS / statement import | **Yes — the CDSL CAS is the primary holdings source** | Promoted from P3 to P1. `07` F19.14 upgraded. |
| Q18 | Currencies | **₹ only, with USD charges on cards** | No foreign account, no foreign Budget account. `07` R31.5 (daily revaluation) is specified but unused. R33 frozen rates apply to USD card transactions. |
| Q19 | Property valuation | **At cost**, with manual revaluation | `07` R23.2 confirmed. |
| Q20 | Holding periods | **Yes** — shown per lot | `07` R25.5 confirmed. Classification visible, nothing computed. |

### Platform and operations

| # | Question | **Decision** | Effect |
|---|---|---|---|
| Q8 | Deployment | **Homelab behind Cloudflare Tunnel** | With server-only data, uptime is load-bearing. See §7. |
| Q21 | Push notifications | **Dropped entirely** | **No service worker anywhere.** `08` R35.6 is withdrawn. See §6. |
| Q22 | Session idle timeout | **30 days**, revocable per device | `08` R38.15 confirmed. |
| Q23 | Impersonation writes | **Read-only by default**, writes behind an explicit in-session toggle | `08` R38.10 confirmed. |
| Q24 | Operational alerts | **Health page only — except backup failures**, which fire an outbound webhook | Narrowed after pushback. See §6. |
| Q25 | Undo window | **30 days** | `08` R37.8 confirmed. |
| Q26 | Month-close ritual | **Yes, P1** | `08` S5 adopted. |

---

## 4. New mechanic — add-on cards

**Priya's Axis card ending 3162 is an add-on on Ravi's Axis account.** `06` R6 modelled every card as its own Credit account, which is wrong here: an add-on shares the primary card's credit limit, appears on the primary's statement, and is settled by one payment.

**Rules — extends `02` R6:**

- R6.a An **add-on card** is a sub-card of an existing Credit account, never a Credit account of its own.
- R6.b The account has **one** outstanding balance, **one** statement, **one** due date and **one** payment category. Add-on spending consumes the same envelope money as primary spending.
- R6.c Every transaction on the account MUST record **which card** it was made on (primary or a named add-on) and **which member** owns it (`02` H2).
- R6.d The account view MUST be able to break spending down by card, so "what did the add-on spend this cycle" is one filter, not a mental exercise.
- R6.e Transaction alerts arriving in the primary holder's inbox that name the add-on's last four MUST resolve to the add-on card and default their owner to that add-on's holder (`04` §3.4).
- R6.f Closing an add-on MUST NOT close the account or its payment category.
- R6.g A credit limit belongs to the account, never to an add-on. Any per-add-on limit is a spending cap, recorded as a note, not as a balance.

**Why it matters beyond bookkeeping:** without R6.c, half the household's card spending arrives attributed to whoever holds the primary card, which quietly defeats the ownership model the household design rests on.

---

## 5. The Q5 conflict — editable history versus reconciliation

**The tension.** Q5 chose "any past month, always editable". `02` F9.3 says a reconciliation creates a locked checkpoint. Both cannot be silently true: an assignment changed in a reconciled month makes the checkpoint's assertion false.

**Resolution — allow it, but never quietly:**

- R7.a Assignments and transactions in **any** past month MAY be edited. There is no hard freeze.
- R7.b Editing anything dated on or before a reconciliation checkpoint MUST require explicit confirmation naming the checkpoint and its date.
- R7.c The checkpoint MUST then be marked **broken**, with the account showing *"reconciled 12-07-2026 — changed since"* until it is reconciled again.
- R7.d Broken checkpoints MUST appear in Review (S4) until resolved.
- R7.e The change MUST be recorded in the event log with both the old and new values (`08` R37), so the reconciliation can be reasoned about afterwards.
- R7.f The app MUST NOT recompute or silently repair a broken checkpoint.

This keeps the flexibility asked for while preserving the one property that makes reconciliation worth doing: you can always tell whether a balance has been asserted correct *since* the last change.

---

## 6. Consequences to propagate

### 6.1 No service worker (Q21)

- `08` R35.6 — **withdrawn**. Push is out of scope.
- `08` F21.2 — the app MUST NOT register a service worker, with no exception.
- `08` F21.7 — withdrawn. The in-app digest (`02` F14.3) is the only notification channel inside the app.
- `02` F14.1 notification types remain, delivered as in-app digest and badge only.
- The client is now: a manifest, static assets, an HttpOnly session cookie, and in-memory view state. Nothing else.

### 6.2 CAS import promoted (Q17)

- `07` F19.14 — upgraded from *SHOULD, P3* to **MUST, P1**. The CDSL CAS is the primary route for holdings.
- The parser must handle a **password-protected PDF**; the password is supplied per import and never stored (`04` PR5).
- CAS rows land in the review queue like any other import (`04` I2), and reconcile against existing holdings rather than duplicating them.
- Manual lot entry remains fully supported and is the fallback for anything the CAS does not cover.

### 6.3 Price providers narrowed (Q16, Q18)

- **MFAPI is the primary and near-sufficient provider.** Free, keyless, covers the portfolio.
- **Alpha Vantage becomes optional.** Configure it only if direct equities appear. Its 25 calls/day is no longer a binding constraint, and the app must work with no key configured.
- **Frankfurter is still needed** — USD card charges require a rate for display and for the frozen transaction rate (R33.1), even with no foreign account.
- `07` R31.5 (foreign Budget accounts with daily revaluation) is specified but **unused**. Do not build the revaluation path until a foreign account exists.
- `07` R34 (asset gain versus FX gain) is **built but currently unexercised** — it activates the moment a USD-priced holding appears.

### 6.4 Alerts (Q24)

- Health page (S15) is the primary surface for all operational status.
- **Exception: failed backup and failed restore-verification fire an outbound webhook** (`08` R40.4, `02` F14.4). This is the one failure class where silence loses data.
- Price-feed failures, job failures and import errors stay on the health page and in Review.

### 6.5 Attachments in scope (Q10)

- Attachments are stored server-side only and **never cached on the device** (`08` R35).
- Every view is a fresh fetch. There is no offline access to a receipt.
- Attachments count toward backup size and toward the restore-verification control totals (`08` R40.2).

### 6.6 Scope reductions

| Now out of the critical path | Because |
|---|---|
| Tranche drawdown, pre-EMI, under-construction home loan (`06` R15, §7.1) | No home loan exists (Q11). Model retained, P3. |
| Moratorium with capitalisation (`06` R16 M4) | The education loan is past moratorium (Q11b). Retained, P3. |
| Service worker, push, Badging API (`08` F21) | Push dropped (Q21). |
| Foreign Budget accounts and daily FX revaluation (`07` R31.5) | ₹-only accounts (Q18). |
| Alpha Vantage as a required provider (`07` §6.4) | Portfolio is mutual funds (Q16). |

---

## 7. Risks accepted

| Risk | Why it is now live | Mitigation in place |
|---|---|---|
| **R30 is not a build-blocking test** (Q15) | The firewall was the containment that made the net-worth reversal safe (`05` §5). Without an automated gate it depends on review discipline. | R30 stays a documented invariant, `02` N11–N12 forbid the failure modes, and it is a review-checklist item. **If net worth ever appears on the budget screen, this is the reason.** |
| **Homelab hosting plus server-only data** (Q8) | If IN-MUM-SRV-1 or the tunnel is down, the app is unusable, not degraded. | Backup failures alert (§6.4); restore verification is a P0 gate; the container runs anywhere, so a VPS move is a migration not a rewrite. |
| **Editable reconciled history** (Q5) | A reconciled balance can be invalidated after the fact. | §5's loud-breakage rule; every change in the event log. |
| **No outbound alerts except backups** (Q24) | A dead price feed or failed import can go unnoticed for weeks. | Both surface in Review and on the health page; neither loses data. Accepted. |
| **Personal loan interest model unconfirmed** (Q11) | Personal loans are frequently quoted flat; entering a flat-rate loan as reducing-balance understates its cost materially. | The interest model is a required field at loan creation, and the equivalent reducing rate is always displayed (`06` R16 M2). |

---

## 8. Revised build order

Supersedes `05` §8.

1. **The event log and idempotency keys** (`08` R36, R37) — before any feature uses them.
2. The budgeting engine as pure testable rules, R1–R13, **including both overspend models** (Q1).
3. The budget screen, server-rendered, with manual entry. Cash as a real account (Q7).
4. Credit-card payment envelopes (`02` R6) **including add-on cards** (§4).
5. Household: both members, ownership, attribution (Q3).
6. "Explain this number" on category balance and Ready to Assign — validates the log.
7. CSV/PDF import for **HDFC, ICICI, Axis, SBI** → review queue → rules engine (Q2).
8. Reconciliation, with the Q5 checkpoint-breakage rule (§5).
9. Backup and **verified restore**, with the failure webhook, before real data lands.
10. Manifest, install instructions, theme, health page. **No service worker** (Q21).

Then P1: loans (three single-disbursement), CAS import, MFAPI prices, month-close ritual, cashflow calendar, Gmail alert parsing.
