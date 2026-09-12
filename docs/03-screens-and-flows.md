# 03 · Screens & Flows

**Draft v0.1 · 26-08-2026.** Layout intent and behaviour, not visual design. No components, no tokens.

---

## 1. The call

**Five primary screens, one of which — Budget — is the product.** Everything else earns its place by being one tap from Budget or by being where you go when something is wrong.

Three supports:

1. **Budget is the home screen on every viewport.** Not a dashboard, not a feed. The first thing you see is Ready to Assign and your categories.
2. **Transaction entry is a global action, not a screen you navigate to.** It is available from everywhere, always, offline, in under five seconds.
3. **Everything corrective lives in one place — the Review queue.** Imports needing attention, uncategorised transactions, suspected duplicates, unfunded cards, overspent categories. One badge, one destination.

---

## 2. Navigation

**Mobile (primary):** bottom bar, five items — Budget · Accounts · Add (centre, prominent) · Review · More.
**Desktop/tablet:** left sidebar with the same five, grouped — *Analyse* (Overview, Cards, Reports, Query, Schedules, Goals, Loans, Portfolio, Net worth) and *Manage* (Payees, Rules, Import, Activity, Health, Settings); Budget grid uses the freed width for more columns.

**Global, always available:**
- Add transaction (FAB on mobile, `A` on desktop)
- Search (`/`)
- **Command palette (`Cmd/Ctrl-K`)** — navigation, actions and search in one overlay (`08` F29)
- **Theme toggle** in the header, on every screen (`08` R39.5)
- Month switcher (on Budget only)
- Connection state, shown only when something is wrong (`08` §12)
- Impersonation banner when active — persistent, high contrast, not dismissible (`08` R38.7)

---

## 3. Screen inventory

### S1 · Budget

The month view. Everything else is subordinate to this.

**Header (sticky, never scrolls away):**
- Month name with back/forward chevrons
- **Ready to Assign** — the largest number on the screen, colour-stated (amber positive / green zero / red negative), tappable to a breakdown of how it was computed (R2)
- Secondary line: *"₹14,200 underfunded across 6 categories"* — tappable, jumps to first underfunded
- Overflow: auto-assign, hold for next month, collapse all, show hidden

**Body:** grouped category rows.

Each row, mobile: `Name` · `Balance` (right, large, colour-stated) with a second line showing target progress as a thin bar and `Assigned ₹X of ₹Y`.
Each row, desktop: `Name` · `Assigned` · `Activity` · `Balance` · target progress bar.

Group headers show subtotals and collapse.

**Row interactions:**
- Tap the assigned figure → inline numeric edit with quick actions (F3.8)
- Tap the row → category detail sheet (S1a)
- Long-press / right-click → move money, set target, hide, rename
- A red (overspent) row shows an inline **Cover** button — one tap to the move-money sheet with suggested sources pre-ranked (R5)

**S1a · Category detail sheet** (bottom sheet on mobile, side panel on desktop):
- Balance, assigned, activity, target status
- Target editor (F4 types, form-based with plain-language preview)
- Auto-assign rule editor (R9, form-based, with preview sentence)
- Upcoming schedules against this category
- Last 12 months of assigned-vs-spent as a small bar pair
- Recent transactions in this category
- Move money in / out

**S1b · Auto-assign preview** (modal): the proposed change per category, the resulting RTA, Apply / Cancel. One-action undo persists for the session and appears as a toast.

---

### S2 · Accounts

**List:** grouped as Budget / Credit / Tracking. Per row: nickname, last four, working balance, and a small state chip — *reconciled 3 days ago*, *12 uncleared*, *due in 4 days*.
Footer: total across Budget accounts, total owed across Credit + liabilities.

**S2a · Account register:** a dense transaction table for one account.
- Columns: date, payee, category, memo, tags, outflow, inflow, cleared, running balance
- Filter bar, multi-select with bulk actions (F4.7), inline edit
- Header shows cleared / uncleared / working balance and a **Reconcile** action
- Uncleared transactions visually distinct

**S2b · Credit card panel** (Credit accounts only, above the register):
- Outstanding, last statement amount + date, due date with countdown
- **Funded** vs **Unfunded** split of the payment category, with the shortfall in words: *"₹3,200 of this balance isn't funded yet"*
- Actions: record payment, fund the shortfall, set payoff target, mark a transaction as EMI

**S2c · Reconcile flow:** enter the bank's balance and date → difference shown → list of uncleared items with checkboxes → either it balances (confirm, lock checkpoint) or offer an adjustment entry (F9.2).

---

### S3 · Add transaction

A sheet, not a page. Opens over whatever you were doing. Works offline.

**Order of fields, top to bottom, because this is the order people think in:**
1. **Amount** — numeric keypad focused on open, accepts expressions (F4.10)
2. **Payee** — autocomplete over history; selecting one pre-fills its usual category and shows *"last: ₹840 on 12-08-2026"*
3. **Category** — pre-filled from payee; shows the category's current balance beside the name so you see the consequence while entering
4. **Account** — defaults to last used
5. Date — defaults to today
6. Collapsed by default: memo, tags, owner, split, attachment, mark cleared

**Save** commits locally and closes immediately; sync happens behind it (PWA2).

**Split mode:** rows of category + amount with a live remainder and *"assign remainder here"*.
**Transfer mode:** replaces payee/category with from-account / to-account. A transfer to a Credit account is labelled **Card payment** and shows the payment category's balance.

---

### S4 · Review

The single destination for everything that needs a human. Badge count = total items.

**Sections, in priority order:**
1. **Imported, needs confirmation** — rows from CSV/PDF/email/SMS, each showing raw string, proposed payee, proposed category, and which rule proposed it. Bulk approve, bulk categorise, approve-and-learn-rule.
2. **Suspected duplicates** — pairs side by side, Keep both / Keep one / Merge, with the match reason stated (`04` §4).
3. **Uncategorised** — transactions in the ledger with no category.
4. **Overspent categories** — with one-tap cover.
5. **Unfunded card balances** — with one-tap fund.
6. **Detected schedules** — proposed recurring transactions to confirm or dismiss (F7.6).
7. **Proposed rules** — learned from your recent categorisation, confirm or dismiss (F6.5).

Every item is dismissible; dismissal is remembered.

---

### S5 · More / hub

Entry points to: Reports, Query, Schedules & Calendar, Goals, **Loans**, **Portfolio**, **Net worth**, Payees, Rules, Tags, Import, Settings, Export & Backup, Demo mode.

---

### S6 · Reports

Preset reports (F10.1) as cards; tapping opens a full-screen chart with the filter bar. Every figure drills to the transaction list behind it. Period presets include FY (Apr–Mar).

---

### S7 · Query

One filterable, sortable, groupable transaction table. Filter chips build up visibly. Group-by category / payee / tag / owner / month. Saveable as a named view, pinned to the More hub. CSV export.

---

### S8 · Schedules & cashflow calendar

**Two tabs.**

*Schedules:* list by next due date, with amount, account, category, confidence chip for detected ones. Add / edit / skip occurrence / mark paid.

*Calendar:* a forward timeline (default 60 days). Each day shows expected inflows and outflows and the projected Budget-account balance. Days where the projection dips below the configured floor are flagged. Tapping a day lists its items. This is the answer to *"will I make it to the 30th?"*

---

### S9 · Goals

Cards with progress ring, target amount, target date, required monthly contribution, linked categories. Separate from the monthly grid by design (F11.2).

---

### S10 · Import

Source picker → for CSV/XLSX: file drop, then column mapping with a saved profile per bank → preview of parsed rows with detected duplicates marked → confirm → lands in Review (S4). Import log with per-batch undo.

---

### S11 · Settings

Household, members, categories management, rules, payees, tags, notifications, appearance, data & backup, demo mode, about/version.

---

### S12 · Loans

Specified in full in `06-loans.md` §8. Summary: a portfolio list of all liabilities; a five-tab loan detail (Overview · Schedule · Payments · Disbursements · What-if); a prepayment sheet whose centrepiece is the tenure-versus-EMI comparison; a rate-change sheet; a record-instalment sheet; and a debt overview across all liabilities including credit cards.

Loan payment categories appear in their own group on Budget (S1); instalments and expected disbursements appear on the cashflow calendar (S8); drift, unconfirmed rate resets, ending moratoria and underfunded instalments appear in Review (S4).

---

### S17 · Cards

*Added after three years of realistic use made the gap obvious (B92, `11` §9).*
`02` R6 models credit cards well and `09` §4 added add-on cards on top, but with
several cards on different statement cycles the daily question is not *how is the
payment envelope doing* — it is **which card is due next, and for how much**.
Nothing answered it without opening each account in turn.

**The screen** — every credit account in **due-date order**, nulls last, with a
summary strip above: total owed, total not funded, and how many fall due within a
week. Each card shows what is owed, what the payment envelope has set aside, and
what has nothing behind it; where a statement has been recorded, its amount, date,
due date and minimum. Urgency is stated in days rather than colour alone.

**Rules:**

- R6.h A shortfall MUST never be reported larger than the balance it describes
  (B92). A household can disprove an impossible figure with arithmetic, and a
  warning they can disprove costs more than it buys.
- R6.i A card with no recorded statement MUST say so plainly rather than invent a
  due date, and MUST still report its funding position.
- R6.j Every shortfall MUST carry the action that fixes it, reaching the same
  cover-overspend flow as S1.

---

### S15 · Health & status · S16 · Command palette

Specified in `08-platform-and-operations.md` §10.

**S15 Health & status** — grouped cards (Application · Data · Jobs · Providers · Backup), each check with state, last-run time and a plain-language reason. Shows last verified restore, remaining Alpha Vantage quota, and whether the dev login bypass is present. The page you open at 2am.

**S16 Command palette** — an overlay on `Cmd/Ctrl-K`: go to, do, find. Keyboard-only from open to execution, and never the sole route to any action.

**Every computed figure** carries an **explain** affordance showing the events that produced it (`08` F25.10).

---

### S13 · Portfolio · S14 · Net worth

Specified in full in `07-assets-networth-currency.md` §8.

**S13 Portfolio** — holdings grouped by account or asset class; per row units, average cost, latest price *with its date*, market value and unrealised gain. A four-tab holding detail (Overview · Lots · Activity · Price) with **XIRR as the headline return**, and for a foreign holding the asset-gain versus FX-gain split stated in words. Selling shows a FIFO preview naming the exact lots consumed before you confirm.

**S14 Net worth** — the figure with its as-of date, a stacked area chart over time, and the period change decomposed into money saved · market movement · FX movement · debt repaid.

**Deliberately absent from Budget (S1).** `07` R30 forbids net worth or portfolio value from appearing there, in any form. That is an acceptance test, not a layout preference.

---

## 4. Key user journeys

### J1 · First run to a working budget (target: under 10 minutes)

Google sign-in → household name → five questions (take-home, pay date, income regularity, card count, EMIs) → generated starting budget shown for editing → add first account with current balance → **RTA appears as a real number** → guided assignment until RTA hits zero → celebration → optional: invite partner, import statement, add schedules.

Escape hatch at every step: *"start blank instead"*.

---

### J2 · The daily spend (target: under 5 seconds)

**Revised 26-08-2026 — this journey previously worked offline. Under the server-only policy (`08` R35) it requires connectivity.**

Phone, with signal. Tap Add → amount → payee (autocompleted after two characters) → category pre-filled → Save. The button shows *"Saving…"* and resolves in under 400ms on a home network. Sheet closes. Category balance decrements on the Budget screen behind it.

**On a weak connection**, the entry retries with its idempotency key for up to twenty seconds before reporting failure, and the typed input stays on screen either way (`08` J21). **With no connection at all, entry is not possible** — the app says so specifically rather than pretending. `08` §3.3 states what that costs and the escape hatch if it proves painful.

---

### J3 · Monthly budgeting session (target: under 5 minutes)

Open Budget on the 1st → header shows RTA = salary that arrived, and *"₹X underfunded across N categories"* → tap **Auto-assign** → preview lists every proposed assignment → Apply → manually adjust two or three rows → RTA reaches zero → *fully funded* state confirmed.

---

### J4 · Overspend recovery

Push or in-app badge: *"Eating out is over by ₹1,850"* → tap → category detail → **Cover** → suggested sources ranked (Entertainment ₹3,200 · Groceries ₹2,400 · Shopping ₹1,900) → tap Entertainment → amount pre-filled at ₹1,850 → confirm. Category returns to zero, Entertainment reduces, RTA unchanged.

---

### J5 · Credit card month

Spend ₹2,400 on the card at a restaurant, charged to Eating Out.
→ Eating Out −₹2,400. HDFC Payments +₹2,400. Card outstanding −₹2,400.
Statement generates on the 18th: S2b shows statement ₹18,400, due 05-09-2026, funded ₹18,400, shortfall ₹0.
Pay the card from savings on the 2nd: record as transfer → HDFC Payments −₹18,400, savings −₹18,400, card outstanding → ₹0. No spending category is touched.

If the shortfall had been ₹3,200, S2b would show it, Review would list it, and a notification would fire five days before the due date (F8.3).

---

### J6 · Statement import

More → Import → pick HDFC Savings → drop the CSV → the saved HDFC mapping profile applies automatically → preview: 84 rows parsed, 61 auto-categorised by rules, 9 flagged as duplicates, 14 uncategorised → Confirm → Review shows 23 items → bulk-categorise the 14 → approve-and-learn creates 4 new rules → next month's import needs almost no work.

---

### J7 · Trip budget without breaking the envelope tree

Create tag `#kerala-oct`. Optionally set a tag budget of ₹35,000. During the trip, transactions get their normal categories (Fuel, Eating Out, Stay) *plus* the tag. The Tags screen shows ₹28,400 of ₹35,000 spent. The envelope structure is untouched.

---

### J8 · Reconciliation

Accounts → HDFC Savings → Reconcile → enter bank balance ₹1,24,380 as of 25-08-2026 → app shows a ₹840 difference → uncleared list shown → tick the ₹840 item as cleared → balanced → confirm → checkpoint locked, *reconciled today* chip appears.

---

### J9 · Partner visibility

Priya enters a ₹3,400 transaction on her phone. Within seconds Ravi's Budget screen shows the reduced category balance; the transaction carries her as owner. Ravi taps it, sees the attribution and history, adds the tag `#reimbursable`. No approval step, no conflict, no notification unless one of them used **flag for partner**.

---

> **Journeys J10–J15 — loans** (adding an under-construction loan, the monthly EMI, deciding a prepayment, a rate reset, card-EMI conversion, closure) are in `06-loans.md` §9.
>
> **Journeys J16–J20 — assets and currency** (adding a SIP, the daily price refresh, selling units with a FIFO preview, a foreign holding's two returns, the monthly net worth review) are in `07-assets-networth-currency.md` §9.
>
> **Journeys J21–J24 — platform** (entering a transaction on a weak connection, "why do I have ₹4,000 less than I thought", reproducing a bug with view-as, the Sunday health check) are in `08-platform-and-operations.md` §11.

---

## 5. States that must be designed, not left to chance

| State | Requirement |
|---|---|
| **Empty budget, no accounts** | Not a blank grid. A single call to action: add your first account, with the starting-template offer. |
| **Empty category (₹0, no target)** | Neutral, not alarming. Zero with no target is a valid state. |
| **RTA negative** | Persistent, unmissable, with a one-tap path to the categories most recently assigned. Never a modal you can dismiss into oblivion. |
| **No connection** | A specific, calm message. Reads and writes are both unavailable; the app says which and offers retry. Never a stale value (`08` R35.3). |
| **Server unreachable but the device is online** | Distinguished from "you are offline" — different cause, different action for the user (`08` §12). |
| **Save failed after retries** | Typed input stays on screen with a retry. The user never re-types (`08` R36.7). |
| **Session expired mid-action** | Re-authenticate in place, then complete the pending action with its original idempotency key — no lost entry, no duplicate. |
| **Server in maintenance / read-only mode** | Explicit banner with the mode and expected duration; reads work, writes are disabled with a reason. |
| **Impersonation active** | Persistent high-contrast banner on every screen, in both themes. Not dismissible (`08` R38.7). |
| **Dev login bypass active** | A visually distinct banner, impossible to confuse with impersonation or with production. |
| **Import with zero recognisable columns** | Mapping UI with the raw rows visible, not an error. |
| **Review queue empty** | A genuine zero-state worth reaching, with the Buffer figure and fully-funded status. |
| **A month in the future with no income yet** | Labelled *"based on money you have today"* (R10). |
| **Loan split shown before the lender confirms it** | Visually marked *estimated* everywhere it appears, never presented as fact (`06` R18.3). |
| **Loan created mid-life with no prior history** | Lifetime figures labelled *"from DD-MM-YYYY"*, never presented as complete (`06` R14). |
| **Every price feed down** | Portfolio and net worth stay fully usable on cached prices, each marked with its actual date. Never blanked, never zeroed (`07` FW9). |
| **A stale price or FX rate** | Marked wherever the derived figure appears — not once at the top of the screen (`07` R26.4, R32.4). |
| **No equity API key configured** | Equity holdings fall back to manual prices; mutual funds and FX are unaffected, since neither provider needs a key. |
| **A price moves more than the sanity band in a day** | Routed to Review rather than into the portfolio (`07` §10). |
| **Very long category list (60+)** | Collapse-by-group by default, search within budget, and a pinned "underfunded only" filter. |
| **Deleted category with history** | Reassignment prompt before deletion (F3.3), never orphaned transactions. |

---

## 6. Mobile adaptations

| Concern | Adaptation |
|---|---|
| Budget grid columns | Mobile shows name + balance + progress bar only; assigned and activity move into the row's second line and the detail sheet |
| Assigning | Inline numeric edit with a keypad and quick-action chips, not a separate page |
| Move money | Bottom sheet with suggested sources as tappable chips |
| Register | Card list rather than a table; horizontal scroll is forbidden |
| Reports | One chart per screen, filters in a bottom sheet |
| Calendar | Vertical list of days rather than a month grid |
| Add transaction | Full-height sheet, amount field focused, keypad up on open |
| Reachability | Primary actions in the lower third of the screen |

---

## 7. Copy principles

**Money between household members is not debt.** *Owes*, *debt*, *write off* and
*forgive* belong to family lending, where the other party is outside the house.
Between partners, say who is **ahead** or **behind** this month, and offer *put it
down to me*, *I'll pick it up*, or *call it even* (`09` R6.n). The arithmetic is
identical; the register is not, and an app that tells someone their partner is in
debt to them is an app that gets closed.

- State the number and the consequence, never just the number: *"₹3,200 of this balance isn't funded"*, not *"Unfunded: 3200"*.
- Never scold. *"Eating out is over by ₹1,850 — cover it from another category?"*, not *"You overspent!"*.
- Explain automated actions in the sentence that offers them: *"Assign ₹4,000 on the 1st of every month, stopping when this category holds ₹20,000"*.
- Name the rule that made a decision, in the place it made it.
- Zero states are achievements, not emptiness: *"Nothing to review. 47 days of spending assigned."*
- Every price and converted figure names its date: *"₹80,874 as of 25-08-2026"*, never a bare number.
- Decomposed figures are stated as sentences, not legends: *"47% of your gain came from the rupee weakening, not the investment."*
- Failure messages name the cause and the next step: *"Couldn't reach the server. Your entry is still here — try again?"*, never *"An error occurred."*
- Distinguish the two failures that look alike: *"You appear to be offline"* and *"The server didn't answer"* need different actions from the reader.
