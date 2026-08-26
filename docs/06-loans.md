# 06 · Loans & Liabilities

**Draft v0.1 · 26-08-2026 · Functional scope only.**
Extends `02-functional-design.md`. Engine rules continue its numbering at **R14**; the functional module is **F18**.

---

## 1. The call

**Model a loan as a projected amortisation schedule that the lender's actuals reconcile against, and expose one number the household actually acts on: what a rupee of prepayment buys.**

Three supports:

1. **Projection alone drifts; actuals alone can't forecast.** The app computes a full schedule so you can ask "what if I pay ₹5,000 extra?", and records each real instalment with the lender's own principal/interest split so the outstanding balance is never a guess. Drift between the two is surfaced, not hidden.
2. **Prepayment is the only decision with real money at stake.** On a ₹50L 20-year loan at 8.5%, a single ₹5,00,000 prepayment at month 24 saves **₹14,57,301 and 45 EMIs** if you cut tenure, but only **₹4,77,894** if you cut the EMI [verified by computation, §12]. That ₹9,79,407 gap is the whole reason this module exists.
3. **Drawdown is a first-class event, not an edge case.** An under-construction home loan is disbursed in tranches, accrues interest on the disbursed portion only, and the money usually never touches your bank account. Every app that models a loan as "principal, rate, tenure" gets this wrong from day one.

---

> **Scope narrowed 26-08-2026.** The household holds **three single-disbursement loans** — an Axis personal loan, a Union Bank education loan already past moratorium, and a Canara loan — and **no home loan**. Tranche drawdown (R15), pre-EMI and the under-construction path (§7.1), and moratorium-with-capitalisation (R16 M4) are therefore **built but seeded with no real data, and move to P3**. Everything else in this document is live. See `09-decisions-log.md` §3.

## 2. Scope decisions (confirmed 26-08-2026)

| Decision | Choice | Consequence |
|---|---|---|
| Loan types in scope | **All four**: home (incl. under-construction), car / personal / gold, education, credit-card EMI & BNPL | The engine is generic; §7 holds the per-type specialisations |
| Disbursement destination | **Per disbursement** | A tranche paid to a builder raises the liability and leaves Ready to Assign untouched; a personal loan credited to savings arrives as income and must be assigned (R15) |
| Source of truth | **App projects, lender reconciles** | Full amortisation schedule for forecasting and what-ifs; each actual instalment carries the lender's real split; drift is reported (R18) |
| Prepayment default | **Reduce tenure, always show both** | Tenure reduction is pre-selected; the side-by-side saving is shown before commit (R19) |

---

## 3. Glossary additions

Extends `02` §3.

| Concept | Definition |
|---|---|
| **Loan** | A liability account with a sanction, a rate model, a repayment schedule and a disbursement history. A specialisation of the Tracking account kind (`02` F2.4). |
| **Sanctioned amount** | What the lender approved. Not necessarily what you owe. |
| **Disbursed amount** | Cumulative principal actually released. Interest accrues on this, never on the sanctioned amount. |
| **Undrawn balance** | Sanctioned − disbursed. Not a liability; shown separately. |
| **Disbursement (tranche)** | One release of principal, with a date, an amount and a **destination** (a Budget account, or paid directly to a third party). |
| **Outstanding principal** | What you owe today, excluding accrued-but-unpaid interest. |
| **Loan payment category** | An auto-created envelope, one per loan, holding money reserved for that loan's instalments. Symmetric with the credit-card payment category (`02` R6). |
| **Instalment (EMI)** | A scheduled payment comprising a principal portion and an interest portion. |
| **Pre-EMI** | An interest-only payment during a construction or moratorium period. Does not reduce principal. |
| **Moratorium** | A period with no principal repayment. Interest either accrues and is **serviced** monthly, or accrues and is **capitalised** into principal. |
| **Amortisation schedule** | The projected instalment-by-instalment split of principal and interest to closure. |
| **Projected schedule** | The app's computation. Used for forecasting and what-ifs. |
| **Actual ledger** | Recorded instalments with the lender's stated split. Authoritative for outstanding balance. |
| **Drift** | Projected outstanding − actual outstanding on the same date. |
| **Part-prepayment** | A payment above the instalment that reduces principal, resolved as either tenure reduction or EMI reduction. |
| **Foreclosure** | Full settlement of outstanding principal before scheduled closure. |
| **Interest saved** | Lifetime interest under the baseline schedule − lifetime interest under the actual/current schedule (R22). |
| **EMIs saved** | Baseline instalment count − current projected instalment count. |
| **Effective rate** | The reducing-balance rate that reproduces the actual total cost. Used to expose flat-rate quoting (R16). |

---

## 4. Engine rules

Continues `02` §4. All examples verified by computation (§12).

---

### R14 — Loan account and sanction

A loan account MUST capture: lender, nickname, loan type, sanctioned amount, sanction date, **rate model** (R16), initial rate, benchmark (repo / MCLR / fixed / flat), tenure in months, first instalment date, instalment day of month, and repayment account.

- A loan is a **liability**. Its balance never funds the budget (`02` R1). It is excluded from Ready to Assign in every state.
- Creating a loan MUST create its **loan payment category** in a "Loan Payments" group. The category cannot be deleted while the loan is open.
- Sanctioned, disbursed and undrawn amounts MUST be displayed as three distinct figures. Only disbursed is a liability.
- A loan MAY be created mid-life: enter current outstanding, current rate, remaining tenure, and optionally the amounts already paid so lifetime metrics are not understated. Where prior history is unknown, lifetime figures MUST be labelled *"from DD-MM-YYYY"* rather than presented as complete.

---

### R15 — Disbursement and drawdown

Each disbursement is an event with a date, an amount and a **destination**.

| Destination | Effect on liability | Effect on Ready to Assign |
|---|---|---|
| **Paid to a third party** (builder, dealer, institution) | Outstanding principal rises by the amount | **Unchanged.** The money never entered a Budget account. |
| **Credited to a Budget account** | Outstanding principal rises by the amount | **Rises by the amount** — it is cash you now hold and must assign (`02` R1) |
| **Split** | Rises by the total | Rises by the portion credited to a Budget account |

**Rules:**

- R15.1 Interest accrues on cumulative disbursed principal only, from each tranche's disbursement date.
- R15.2 A disbursement to a Budget account MUST appear in the review queue as income requiring assignment, never as an uncategorised transaction.
- R15.3 A disbursement to a third party MUST NOT create a transaction in any Budget account and MUST NOT affect RTA. This is the rule that stops a ₹40 lakh builder payment from appearing as ₹40 lakh of spendable money.
- R15.4 Recording a disbursement MUST recompute the projected schedule and the current pre-EMI or EMI amount.
- R15.5 The undrawn balance MUST be shown with an optional expected-disbursement schedule feeding the cashflow calendar (`02` F7.7).

**Worked example — under-construction home loan, ₹50,00,000 sanctioned at 8.5%:**

| Event | Disbursed | Destination | Monthly obligation |
|---|---|---|---|
| Tranche 1 — ₹10,00,000 | ₹10,00,000 | Builder | Pre-EMI **₹7,083** (interest only) |
| Tranche 2 — ₹15,00,000 | ₹25,00,000 | Builder | Pre-EMI **₹17,708** |
| Final tranche — ₹25,00,000 | ₹50,00,000 | Builder | Full EMI **₹43,391** over 240 months |

Ready to Assign is untouched throughout. The budget carries a growing pre-EMI obligation, which the loan payment category must be funded for each month.

---

### R16 — Interest models

The app MUST support four accrual models. The model is fixed per loan at creation and changeable only with an explicit recompute.

**M1 · Reducing balance (monthly rest)** — the default and the correct model for home, education and most car loans.

```
monthly interest = outstanding principal × (annual rate ÷ 12)
```

**M2 · Flat rate** — common on car, personal, gold and consumer-durable loans, and the reason quoted rates mislead.

```
total interest = original principal × annual flat rate × years
instalment     = (principal + total interest) ÷ months
```

The app MUST compute and display the **equivalent reducing-balance rate** beside any flat-rate loan, because the difference is not small.

*Worked example — ₹8,00,000 car loan at 9% flat over 60 months:* total interest **₹3,60,000**, EMI **₹19,333**, equivalent reducing-balance rate **15.71% p.a.** The headline "9%" is 15.71% in the only sense that matters.

**M3 · Moratorium with servicing** — interest accrues and is paid monthly; principal untouched. Used for pre-EMI (R15) and serviced education-loan moratoria.

**M4 · Moratorium with capitalisation** — interest accrues, is not paid, and is added to principal at the end of the moratorium. The app MUST warn about this at loan creation and MUST quantify it.

*Worked example — ₹15,00,000 education loan at 10.5%, 48-month moratorium, 10-year repayment:*

| | Serviced monthly (M3) | Capitalised (M4) |
|---|---|---|
| Paid during moratorium | ₹13,125/month, ₹6,30,000 total | ₹0 |
| Balance at repayment start | ₹15,00,000 | **₹22,78,776** (₹7,78,776 added) |
| EMI thereafter | ₹20,240 | **₹30,749** |
| Difference | — | **₹10,508/month more, for ten years** |

**Rate MUST be versioned with effective dates.** Changing a rate never rewrites history; it creates a new rate period and recomputes the schedule forward (R20).

---

### R17 — Projected amortisation schedule

The app MUST compute a full instalment-by-instalment schedule to closure, showing per instalment: number, due date, opening balance, instalment amount, principal portion, interest portion, closing balance, and cumulative interest.

- R17.1 The schedule MUST be recomputed on: disbursement, rate change, prepayment, extra payment, tenure change, instalment change, or a recorded actual that differs materially from projection.
- R17.2 The schedule MUST be exportable to CSV and viewable in full, not just summarised.
- R17.3 The schedule MUST show a **baseline** — the schedule as at origination — alongside the current projection, so savings are measurable (R22).
- R17.4 A schedule MUST never produce negative amortisation. If the instalment is less than the monthly interest, the app MUST refuse the configuration and say why. *This mirrors the RBI requirement that tenor elongation must not cause negative amortisation and that EMIs must always cover the monthly interest [verified, §11].*

*Worked example — ₹50,00,000 at 8.5% over 240 months:* EMI **₹43,391**, lifetime interest **₹54,13,879**, total repaid **₹1,04,13,879**. You repay slightly more than double.

---

### R18 — Recording an actual instalment, and drift

The instalment is a **transfer** from a Budget account to the loan account, funded from the loan payment category.

**On recording an instalment of ₹43,391:**

1. The loan payment category is reduced by the full ₹43,391.
2. The loan's outstanding principal is reduced by the **principal portion** only.
3. The **interest portion** is recorded as an interest expense attributed to that loan, and counted toward lifetime interest paid (R22).
4. The Budget account balance falls by ₹43,391.

This is symmetric with credit-card payments (`02` R6): one category to fund, one number to budget, correct accounting underneath.

**Split source, in priority order:**

- R18.1 The lender's stated split, where entered or parsed from a statement — **authoritative**.
- R18.2 Otherwise the projected split for that instalment number, marked **estimated**.
- R18.3 An estimated split MUST be visually distinguishable from a confirmed one, everywhere it appears.

**Drift.**

- R18.4 The app MUST compute drift = projected outstanding − actual outstanding, on every reconciliation.
- R18.5 Drift beyond a threshold (default ₹500 or 0.1% of outstanding, whichever is larger) MUST raise a review-queue item, not a silent correction.
- R18.6 Resolving drift MUST offer: accept the lender's balance and re-anchor the projection from it (default), or investigate with a side-by-side of projected versus recorded instalments.
- R18.7 Re-anchoring MUST NOT alter recorded history or lifetime interest paid. It changes the forward projection only.
- R18.8 The app MUST support a **loan reconciliation** against a lender statement — outstanding principal, interest paid year-to-date, instalments remaining — creating a locked checkpoint as in `02` F9.

Common, legitimate causes of drift the app SHOULD name when reporting it: mid-cycle rate reset, value-date versus due-date differences, part-month interest on a first instalment, rounding conventions, and fees added to principal.

---

### R19 — Extra payments and part-prepayment

Two distinct things, both required.

**Recurring extra payment** — paying more than the instalment, every month.

*Worked example — ₹5,000 extra per month from month 1 on the ₹50L loan:* lifetime interest falls to **₹40,24,629**, saving **₹13,89,250** and **53 EMIs** — the loan closes in 187 months instead of 240, **4 years 5 months early**.

**Part-prepayment** — a lump sum against principal.

- R19.1 Recording a prepayment MUST require an explicit resolution: **reduce tenure** (default) or **reduce EMI**.
- R19.2 Before commit, the app MUST show both outcomes side by side: new tenure, new EMI, interest saved, EMIs saved.
- R19.3 The default MUST be tenure reduction, with the reason stated in one line.
- R19.4 Prepayment MUST be fundable from a category, from Ready to Assign, or from a dedicated prepayment goal (`02` F11), and the funding source MUST be explicit — a ₹5,00,000 prepayment cannot silently drain envelopes.
- R19.5 The app MUST record any prepayment charge as a separate cost, and MUST include it in the net saving.
- R19.6 The app SHOULD warn when a prepayment would leave the emergency-fund category below its target, and MUST NOT block it (`02` P2).

*Worked example — ₹5,00,000 prepaid at month 24 on the ₹50L loan:*

| | Reduce tenure *(default)* | Reduce EMI |
|---|---|---|
| EMI after | ₹43,391 *(unchanged)* | **₹38,864** *(−₹4,527/month)* |
| Tenure after | **195 months** *(−45 EMIs)* | 240 months *(unchanged)* |
| Lifetime interest | ₹39,56,578 | ₹49,35,985 |
| **Interest saved** | **₹14,57,301** | ₹4,77,894 |

Tenure reduction saves **₹9,79,407 more**. The app states exactly this sentence, with the household's own numbers, at the moment of the decision.

- R19.7 The app MUST provide a **what-if calculator** that models a prepayment without recording it: amount, month, and resolution, showing the same comparison. This is the feature people will open the app for.

---

### R20 — Rate reset and restructure

- R20.1 A rate change MUST be recorded as a dated rate period, never as an edit to the existing one.
- R20.2 On a rate change the app MUST present the borrower's options and their consequences: **keep the EMI and let tenure move**, **keep the tenure and let the EMI move**, or a combination. *RBI requires lenders to offer switching to a fixed rate, enhancing the EMI, elongating the tenor, or a combination, plus prepayment [verified, §11].*
- R20.3 The app MUST enforce R17.4 — no configuration producing negative amortisation.
- R20.4 A benchmark-linked loan SHOULD record its benchmark, spread and reset frequency, and SHOULD prompt for confirmation of the new rate at each expected reset rather than assuming one.
- R20.5 Switching from floating to fixed (or the reverse) MUST be recordable, with any conversion fee captured as a cost.

*Worked example — the ₹50L loan resets from 8.5% to 9.0% at month 24, outstanding ₹47,92,181:*

| Option | Result |
|---|---|
| Keep EMI at ₹43,391 | Tenure extends to **236 months** — 20 months longer |
| Keep tenure at 216 months | EMI rises to **₹44,876** — ₹1,485 more per month |

---

### R21 — Closure and foreclosure

- R21.1 Foreclosure MUST be recordable as a single settlement: outstanding principal + accrued interest to date + any charges.
- R21.2 On closure the app MUST present a **loan summary**: total borrowed, total repaid, lifetime interest paid, interest saved versus baseline, EMIs saved, and actual versus original closure date.
- R21.3 A closed loan MUST be archived, not deleted, and MUST remain in lifetime reporting.
- R21.4 The loan payment category MUST be closed with any residual balance returned to Ready to Assign, with confirmation.
- R21.5 The app SHOULD prompt to redirect the freed EMI — *"₹43,391/month is now free. Assign it?"* — because this is the moment households quietly absorb the money into lifestyle.

---

### R22 — Lifetime metrics

Definitions must be exact, because these numbers get quoted.

| Metric | Definition |
|---|---|
| **Lifetime interest paid** | Sum of interest portions of all **recorded actual** instalments and settlements. Never includes projected interest. |
| **Lifetime interest projected** | Lifetime interest paid + sum of interest portions of all remaining projected instalments. Always labelled as projected. |
| **Baseline lifetime interest** | Total interest under the schedule as at origination — original principal, original rate, original tenure, no prepayments. |
| **Interest saved** | Baseline lifetime interest − lifetime interest projected. Positive means ahead. |
| **EMIs saved** | Baseline instalment count − current projected instalment count. |
| **Time saved** | Baseline closure date − projected closure date, in years and months. |
| **Total cost of borrowing** | Lifetime interest projected + all fees, charges, insurance premiums bundled into the loan, and prepayment charges. |
| **Effective rate** | The reducing-balance annual rate that reproduces total cost of borrowing over the actual disbursement and repayment pattern. Exposes flat-rate quoting (R16 M2) and fee loading. |
| **Principal repaid to date** | Cumulative principal portions of recorded instalments plus prepayments. |
| **Loan-to-date progress** | Principal repaid ÷ total disbursed, as a percentage. |

**Rules:**

- R22.1 Every metric MUST state whether it is actual or projected, in the label, not in a footnote.
- R22.2 Interest saved MUST be attributable — a breakdown showing how much came from prepayments, from extra monthly payments, and from rate movements.
- R22.3 Where loan history predates the app, all lifetime metrics MUST be labelled *"from DD-MM-YYYY"* (R14).
- R22.4 Rate movements MUST be excluded from "interest saved by your actions" and reported separately, so a rate cut is not presented as the household's achievement.

---

## 5. Module F18 · Loans

- F18.1 The app MUST support loan accounts per R14, of types: home, home (under construction), car, personal, gold, education, loan against property, credit-card EMI, BNPL, other.
- F18.2 The app MUST support multiple disbursements per loan with per-disbursement destinations (R15).
- F18.3 The app MUST support the four interest models in R16 and MUST version rates with effective dates.
- F18.4 The app MUST generate, display and export a full amortisation schedule (R17).
- F18.5 The app MUST auto-create and maintain a loan payment category per loan (R14, R18).
- F18.6 Recording an instalment MUST split principal and interest per R18, using the lender's figures where available.
- F18.7 The app MUST support extra monthly payments and part-prepayments with the comparison in R19.
- F18.8 The app MUST provide a non-committing prepayment what-if calculator (R19.7).
- F18.9 The app MUST compute and display drift and MUST route material drift to the review queue (R18.4–R18.6).
- F18.10 The app MUST support loan reconciliation against a lender statement with a locked checkpoint (R18.8).
- F18.11 The app MUST record fees, charges, insurance premiums and prepayment charges against the loan and include them in total cost (R22).
- F18.12 The app MUST report every metric in R22, each labelled actual or projected.
- F18.13 The app MUST support foreclosure and closure with a summary (R21).
- F18.14 The app MUST generate a schedule for each loan feeding the cashflow calendar (`02` F7.7), including expected future disbursements.
- F18.15 The app MUST notify when: an instalment is due and its payment category is underfunded, a rate reset is expected, a moratorium is ending, a prepayment goal has been reached, or a loan is within three instalments of closure.
- F18.16 The app MUST provide a **portfolio view** across all liabilities: outstanding, rate, monthly obligation, projected closure, lifetime interest, and total monthly debt outgo.
- F18.17 The app SHOULD compute a debt-to-income ratio from total monthly obligation and recorded income, labelled as indicative.
- F18.18 The app SHOULD support a prepayment strategy comparison across loans — avalanche (highest rate first) versus snowball (smallest balance first) — showing interest and time saved under each for a given surplus.
- F18.19 The app SHOULD flag a loan whose rate is materially above the household's other loans of the same type as a refinance candidate, without recommending a lender.
- F18.20 The app MUST allow a loan to be created mid-life without prior history, with lifetime metrics scoped accordingly (R14, R22.3).

---

## 6. Interaction with the budgeting engine

The loan module must not corrupt envelope semantics. These are the invariants.

| # | Invariant |
|---|---|
| LB1 | A loan balance never contributes to Ready to Assign, in any state (`02` R1). |
| LB2 | A third-party disbursement never creates cash and never moves RTA (R15.3). |
| LB3 | A disbursement into a Budget account is income and MUST be assigned like any other income. |
| LB4 | The full instalment is budgeted in the loan payment category; the principal/interest split is an accounting detail below it, not a second envelope (R18). |
| LB5 | Interest is a real expense and MUST appear in spending reports; principal is a transfer and MUST NOT. |
| LB6 | A prepayment MUST have an explicit funding source and MUST reduce it visibly (R19.4). |
| LB7 | An underfunded loan payment category at due date is a warning, never a block (`02` P2). |
| LB8 | Interest saved is a metric, never money. It MUST NOT appear in RTA, in any category, or in net worth. |
| LB9 | Freed EMI on closure returns to RTA only via the explicit prompt in R21.5. |
| LB10 | Pre-EMI and moratorium interest are expenses in the month incurred, budgeted like any other (M3); capitalised interest (M4) is not an expense until repaid as part of an instalment. |

---

## 7. Per-type specialisations

### 7.1 Home loan, including under construction

- Tranche disbursement with third-party destination is the norm (R15).
- Pre-EMI during construction; full EMI once fully disbursed [verified, §11].
- The app MUST support switching from pre-EMI to full EMI early, and MUST quantify the interest saved.
- Floating rate linked to an external benchmark, with resets (R20).
- SHOULD track deductible interest and principal separately per financial year (Apr–Mar) for tax purposes, as a **report only** — the app computes no tax liability and gives no tax advice.
- SHOULD track associated costs kept outside the loan: registration, stamp duty, processing fee, property insurance.

### 7.2 Car, personal, gold

- Single disbursement, usually to a dealer (car) or to the borrower (personal, gold).
- Frequently quoted **flat rate** — the equivalent reducing rate MUST be shown (R16 M2).
- Shorter tenures make prepayment economics different; the comparison in R19 still applies.
- Gold loans may be bullet-repayment (interest serviced, principal at maturity) — the app MUST support an interest-only schedule with a principal balloon.

### 7.3 Education loan

- Moratorium = course duration + grace period, with servicing or capitalisation (R16 M3/M4). The app MUST make the capitalisation cost explicit at setup, quantified as in R16.
- Disbursement is typically per semester, to the institution — third-party destination (R15).
- SHOULD track interest paid per financial year as a report, for the borrower's own use in claiming interest deduction. No tax computation, no advice.
- Co-borrower SHOULD be recordable as a note.

### 7.4 Credit-card EMI and BNPL

Extends `02` R6, which sketched this.

- Converting a card transaction to EMI MUST: reduce the card's revolving outstanding by the converted amount, create a loan of type credit-card EMI, and create its own payment category.
- Processing fee and GST MUST be captured as costs (₹199 + 18% GST = ₹235 in the example below), and included in total cost of borrowing.
- The card's payment category expectation MUST fall by the converted amount so the household is not asked to fund it twice — this is the specific bug to avoid.
- The EMI instalment appears on the card statement, so its payment is recorded against the card, while the EMI loan's outstanding reduces. Both views must agree.
- Foreclosing a card EMI usually attracts a charge; it MUST be recordable (R19.5).
- An EMI converted on an **add-on card** belongs to the primary account, and its instalments appear on that account's statement. The EMI loan records which card the original purchase was made on (`09` §4, R6.c).
- BNPL is modelled identically, usually at zero stated interest with fees carrying the cost — which the effective rate (R22) exposes.

*Worked example — ₹60,000 converted to 12-month EMI at 15% with a ₹199 processing fee:* EMI **₹5,415**, interest **₹4,986**, fee plus GST **₹235**, total cost of borrowing **₹5,221**.

---

## 8. Screens

Extends `03-screens-and-flows.md`.

### S12 · Loans

Reached from Accounts (liabilities section) and from the More hub.

**S12 · Portfolio list.** One row per loan: nickname and lender, outstanding, rate with a movement chip, monthly obligation, projected closure date, progress bar of principal repaid. Footer: total outstanding, total monthly obligation, blended rate, aggregate lifetime interest paid.

**S12a · Loan detail.** Five tabs.

| Tab | Contents |
|---|---|
| **Overview** | Outstanding, sanctioned, undrawn. Current rate and effective rate. EMI, next due date, payment-category funded state. Progress ring of principal repaid. Four headline metrics: lifetime interest paid *(actual)*, projected remaining interest, interest saved, EMIs saved. A single-sentence status: *"On track to close in Feb 2039, 45 EMIs and ₹14,57,301 ahead of the original schedule."* |
| **Schedule** | The amortisation table (R17). Recorded instalments distinguished from projected; confirmed splits distinguished from estimated (R18.3). Filter by year. Export CSV. |
| **Payments** | Recorded instalments, prepayments, extra payments, fees. Each shows principal, interest, balance after, and whether the split was confirmed or estimated. |
| **Disbursements** | Tranche history with destinations, plus expected future disbursements. Undrawn balance prominent. |
| **What-if** | The prepayment calculator (R19.7) and the extra-monthly-payment simulator, both non-committing. |

**S12b · Prepayment sheet.** Amount → funding source (category, RTA, or prepayment goal) → prepayment charge if any → **the side-by-side comparison** with tenure reduction pre-selected → the difference stated in one sentence → confirm. Post-commit toast with undo.

**S12c · Rate change sheet.** New rate, effective date, then the R20 options as two cards with their consequences. Negative-amortisation configurations are refused with an explanation (R17.4).

**S12d · Record instalment sheet.** Date, amount, and a principal/interest split that is pre-filled from the projection and clearly marked *estimated* until the user overwrites it with the lender's figures.

**S12e · Debt overview.** All liabilities including credit cards: total outstanding, total monthly outgo, blended rate, debt-to-income if income is known. The avalanche-versus-snowball comparison for a given monthly surplus (F18.18).

**Additions to existing screens:**

- **Budget (S1):** loan payment categories appear in their own group with the next due date on the row.
- **Cashflow calendar (S8):** instalments and expected disbursements appear as dated items.
- **Review (S4):** new item types — material drift, expected rate reset unconfirmed, moratorium ending, underfunded instalment due.
- **Reports (S6):** interest paid by loan by period; interest versus principal over time; total debt outstanding over time.

---

## 9. Journeys

**J10 · Adding an under-construction home loan.** Lender, sanction ₹50,00,000, 8.5% floating on repo, 240 months, first disbursement expected next month → app creates the loan, the payment category, and a schedule showing pre-EMI of ₹0 until the first tranche → record tranche 1 of ₹10,00,000 paid to the builder → obligation becomes ₹7,083/month pre-EMI, RTA unchanged → the pre-EMI appears on the budget screen and in the calendar.

**J11 · The monthly EMI.** Schedule fires on the 5th → payment category shows funded ₹43,391 → confirm → outstanding falls by the principal portion, interest is expensed, savings falls by ₹43,391. If the lender's statement later gives a different split, correct it in S12d; lifetime interest updates, history is preserved.

**J12 · Deciding a prepayment — the core journey.** Bonus arrives, ₹5,00,000 sitting in a goal category → S12a What-if → enter ₹5,00,000 → *"Reduce tenure: save ₹14,57,301 and 45 EMIs. Reduce EMI: save ₹4,77,894, EMI falls ₹4,527. Tenure reduction saves ₹9,79,407 more."* → commit from S12b, funding source the goal category → schedule and all metrics recompute → the goal is marked achieved.

**J13 · Rate reset.** Notification: *"HDFC home loan reset expected this month."* → confirm the new rate 9.0% → two cards: keep EMI (tenure +20 months) or keep tenure (EMI +₹1,485) → choose → schedule recomputes; the interest impact is attributed to rate movement, not to household action (R22.4).

**J14 · Card EMI conversion.** Open the ₹60,000 card transaction → *convert to EMI* → 12 months, 15%, ₹199 fee → a card-EMI loan is created with its own payment category, the card's payment expectation drops by ₹60,000, and the total cost of ₹5,221 is shown before confirming.

**J15 · Closure.** Final instalment recorded → summary: borrowed ₹50,00,000, repaid ₹89,56,578, lifetime interest ₹39,56,578, saved ₹14,57,301 and 45 EMIs, closed 3 years 9 months early → *"₹43,391/month is now free. Assign it?"* → goes to RTA on confirmation.

---

## 10. Edge cases that must be designed

| Case | Required behaviour |
|---|---|
| Instalment paid late, with penal interest | Recordable as a separate charge; not silently absorbed into the interest portion |
| Instalment bounced and re-presented | One obligation, two attempts; must not double-count |
| Part-month interest on the first instalment | Expected drift; named as such in R18's drift explanation |
| Rate reset mid-cycle | Schedule splits the month across two rate periods; drift threshold must tolerate it |
| Fees added to principal | Increases outstanding without being a disbursement; included in total cost |
| Loan taken over / balance transferred to another lender | Close the old loan as foreclosed, open the new one, and carry baseline metrics forward so lifetime interest is not reset to zero |
| Top-up loan on an existing facility | A new disbursement on the same loan, or a separate loan — user's choice, default separate |
| Moratorium extended | New rate/period record; capitalisation recomputed and quantified |
| Loan in a currency other than ₹ | Out of scope for P0; must fail clearly rather than silently mis-compute |
| Joint loan where the household pays a share | Record the household's share as the obligation; note the full loan for reference |
| Prepayment charge on a fixed-rate loan | Recordable and included in net saving; must not be assumed zero (§11) |
| Zero-interest BNPL with a fee | Effective rate must be computed and shown; "0%" must never be displayed unqualified |

---

## 11. Indian regulatory and product facts

[verified 26-08-2026 — sources in §13. Re-check before relying on these; regulation moves.]

**Prepayment and foreclosure charges.** RBI has directed that for **floating-rate loans sanctioned or renewed on or after 1 January 2026**, regulated entities may not levy prepayment charges on loans to **individuals for non-business purposes**, irrespective of co-obligants. For business-purpose loans to individuals and MSEs, commercial banks are likewise prohibited, while small finance banks, regional rural banks and certain cooperative banks may not charge on loans up to **₹50 lakh**. There is **no minimum lock-in period**, **no restriction on the source of prepayment funds**, and the prohibition covers **both part and full prepayment**. **Fixed-rate loans are treated separately** — charges on the prepaid amount remain permissible for term loans. Applicability must be disclosed in the sanction letter, the loan agreement and the Key Facts Statement.

*Design consequence:* the app must never assume a prepayment charge is zero. It captures the charge as an input, defaulting to zero for a floating-rate individual loan and defaulting to "ask" otherwise, and includes whatever is entered in the net saving (R19.5).

**Floating-rate resets.** RBI requires lenders, at reset, to offer borrowers the option to **switch to a fixed rate** (subject to the lender's board-approved policy, which may cap the number of switches), to **increase the EMI**, to **extend the tenor**, or a **combination**, and to **prepay in part or full**. Lenders must disclose the impact of rate changes on EMI and tenure at sanction, and must provide **quarterly statements** showing principal recovered, interest paid, remaining instalments and the applicable rate. Critically, **tenor elongation must not result in negative amortisation**, and the EMI must always cover the monthly interest.

*Design consequence:* R20.2 presents exactly these options; R17.4 enforces the negative-amortisation prohibition as a hard refusal in the app.

**Tranche disbursement.** On an under-construction property, funds are released against construction milestones; **interest is charged only on the amount disbursed**, not the sanctioned amount. **Pre-EMI covers interest only and does not reduce principal.** **Full EMI begins once the sanctioned amount is fully disbursed**, and moving to full EMI earlier reduces total interest.

**Flat versus reducing balance.** A flat rate applies interest to the **entire original principal for the whole tenure**, regardless of repayment; a reducing-balance rate applies it only to the **outstanding balance**, recalculated after each instalment. A flat rate "appears cheaper with a lower quoted rate, but costs more." This is why R16 requires the equivalent reducing rate to be shown.

**Not verified, and deliberately excluded:** any tax treatment of interest or principal. The app reports interest and principal paid per financial year and computes no deduction, no liability and no advice.

---

## 12. Verification

Every figure in this document was computed rather than recalled, and the computation ships beside this document as **`verify_amortisation.py`**. Run it to re-check the table below; it exits non-zero if any figure has drifted.

```
python verify_amortisation.py                          # verify every figure here
python verify_amortisation.py emi 5000000 8.5 240      # EMI and lifetime interest
python verify_amortisation.py prepay 5000000 8.5 240 500000 24   # the R19 comparison
```

The model is a standard reducing-balance amortisation with monthly rests:

```
EMI = P × r × (1+r)^n ÷ ((1+r)^n − 1),   r = annual rate ÷ 1200
```

| Example | Inputs | Result |
|---|---|---|
| Home loan baseline | ₹50,00,000 · 8.5% · 240m | EMI ₹43,391 · interest ₹54,13,879 · repaid ₹1,04,13,879 |
| Prepay, tenure | +₹5,00,000 at m24 | 195m · interest ₹39,56,578 · **saved ₹14,57,301 / 45 EMIs** |
| Prepay, EMI | +₹5,00,000 at m24 | EMI ₹38,864 · interest ₹49,35,985 · **saved ₹4,77,894** |
| Extra monthly | +₹5,000/m from m1 | 187m · interest ₹40,24,629 · **saved ₹13,89,250 / 53 EMIs** |
| Pre-EMI | ₹10,00,000 drawn · 8.5% | ₹7,083/m · at ₹25,00,000 drawn, ₹17,708/m |
| Car loan, flat | ₹8,00,000 · 9% flat · 60m | interest ₹3,60,000 · EMI ₹19,333 · **equivalent 15.71% reducing** |
| Card EMI | ₹60,000 · 15% · 12m · ₹199 fee | EMI ₹5,415 · interest ₹4,986 · fee+GST ₹235 · cost ₹5,221 |
| Education, serviced | ₹15,00,000 · 10.5% · 48m mor. | ₹13,125/m serviced · ₹6,30,000 · then EMI ₹20,240 |
| Education, capitalised | same | +₹7,78,776 · balance ₹22,78,776 · EMI ₹30,749 · **+₹10,508/m** |
| Rate reset | 8.5%→9.0% at m24, bal ₹47,92,181 | keep EMI → 236m (+20m) · keep tenure → EMI ₹44,876 (+₹1,485) |

All 33 figures verify as at 26-08-2026.

Rounding: figures are rounded half-up to the rupee for display; the engine MUST carry unrounded values internally and MUST NOT accumulate rounding error across a 240-instalment schedule. `verify_amortisation.py` demonstrates the required behaviour, including the R17.4 refusal of any configuration that would produce negative amortisation.

---

## 13. Sources

- [RBI rule on prepayment charges effective 1 January 2026 — Upstox](https://upstox.com/news/personal-finance/financial-regulations/new-rbi-rule-on-prepayment-charges-for-floating-rate-home-personal-mse-loans-from-january-1-2026-explained/article-177494/)
- [RBI circular on floating-rate reset options — Business Standard](https://www.business-standard.com/amp/finance/personal-finance/explained-borrowers-can-change-tenures-emis-and-switch-to-fixed-rates-during-loan-resets-123082100100_1.html)
- [Home loan tranche disbursement — Bajaj Housing Finance](https://www.bajajhousingfinance.in/resources/home-loan-tranche-disbursement)
- [Flat rate vs reducing balance — Shriram Finance](https://www.shriramfinance.in/financial-faq-what-is-the-difference-between-flat-rate-and-reducing-balance)
