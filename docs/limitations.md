# Limitations

Known constraints of the current build.

## Budgeting

**Past months are recomputed, not frozen.** Viewing an earlier month applies
current data, including assignments made in later months. A past month's Ready
to Assign can therefore read lower than it did at the time. Closed months record
their figures in `month_closes`, which is the durable record. See
[dev/01-engine-derivation.md](dev/01-engine-derivation.md) §4.

**A budget spans at most a hundred years.** The engine walks every month from
the first one with data, and stops after 1,200. A month beyond that is refused
by name — viewing it, or assigning money to it — rather than shown with the last
month the walk reached; so is an assignment that would stretch the walk past it.

**One household per deployment.** There is no multi-tenancy. Two households need
two deployments.

**Overspend model is household-wide.** It cannot differ per budget or per
envelope.

## Projections

**The independence projection is arithmetic, not a forecast.** It extrapolates
a trailing window of spending forward unchanged and applies a fixed real return
every year. Real markets arrive in a sequence, and retiring into a bad first
decade fails on the same average return that succeeds arriving later — that
sequence-of-returns risk is not modelled, and no safe-withdrawal figure can
make it go away.

**Spending is assumed to stay as it is.** A loan that finishes, a child, a
parent needing care, or a move all change the target, and none of them are
projected. The trailing window is the only input.

**No tax.** Withdrawals are treated as spendable in full. Capital gains on
redemption are not deducted from the corpus, so a portfolio of equity held
outside a retirement account will not stretch quite as far as the figure
suggests.

**A short history scales up whatever it has.** With less than a year of data
the window is annualised from the days that exist — history starts at the first
transaction or the first budget or card account opened, whichever is earlier —
and the screen says so, but one unusual month still moves the target a long
way.

**Investing is not spending.** Units bought through the portfolio are left out
of the spending the target is built on, even when paid from an envelope. An
investment made any other way — a transfer to a tracking account filed to an
envelope, say — still counts as spending.

## Deposits

**One rate for a deposit's whole life.** A PPF's or EPF's rate is reset by the
government each quarter or year; a deposit's terms carry one rate, and changing
it re-prices every past day too. Net worth snapshots already written keep the
figure they were taken with.

**No interest after maturity, and no renewal.** A matured deposit is held at
its maturity value until somebody records what happened to the money. A bank
pays a savings rate on an overdue deposit and may renew it automatically;
neither is assumed. Nothing is posted at maturity.

**Interest paid out is not projected.** A deposit paying its interest out is
worth its principal; the payouts do not appear on the cashflow calendar unless
they are entered as a schedule.

**A retirement balance created in Portfolio cannot take terms.** Its register
cannot hold contributions. Track a PPF or EPF whose value should be computed as
an "Other asset" tracking account instead.

**Tax deducted at source is not modelled.** The computed value is gross.


**It is an estimate, not a return.** Arithmetic on figures the person enters,
under the slabs the app carries. It files nothing, it is not advice, and it is
not a substitute for an accountant.

**What it does not model**, each of which changes the answer: marginal relief
on surcharge and on the 87A cliff, so a figure just over a threshold is
overstated; losses set off between heads or carried forward, and a let-out
house's loss and rent; clubbing; foreign income and treaty relief; presumptive
schemes under 44AD and 44ADA; interest under 234A, 234B and 234C, which the
screen names and does not compute; and the resident senior citizen's exemption
from advance tax (s207).

**Home loan interest under 24(b) is carried from the ledger (TAX-1).** A loan
marked as for a house its owner lives in contributes the interest accrued in
the financial year — each instalment's interest spread over the days it pays
for, with instalments not yet recorded taken from the projected schedule — to
its holder's estimate, old regime only (s115BAC allows none under the new),
capped at ₹2,00,000 across every such house. The cap is keyed by year with the
slabs. A let-out house's interest is shown and not deducted. Not modelled:
interest before construction is finished (claimed in five parts from the year
it is; a loan typed "under construction" is not carried), the ₹30,000 limit on
a loan taken before April 1999 or for repairs, and a joint loan's split between
co-borrowers — the whole loan is carried to its holder, and each borrower's
share is entered as an override. Where any of the figure is not the lender's
own split it is marked estimated; the lender's certificate is the number to
use, entered in the same box. Figures as retrieved on 22-10-2026 from secondary
sources (the department's site was not reachable to check against).

**Tax already paid is netted (TAX-2).** TDS for the year is entered as one figure
from Form 16 or 26AS — nothing is read from either — and advance and
self-assessment tax are entered a challan at a time. Each regime's estimate,
less all three, is shown as a balance to pay or a refund.

**Advance tax is measured against what was paid (TAX-3).** Where the year's
tax under the lower regime, less TDS, is ₹10,000 or more, the four instalments
(15%, 45%, 75% and 100% by 15 June, 15 September, 15 December and 15 March)
are shown with what was paid by each date and any shortfall. The threshold and
dates are keyed by year; they are unchanged under the Income-tax Act, 2025.
Nothing is scheduled or reminded.

**Section 80D is modelled as the Act has it** (old regime only): premiums for
yourself, spouse and children up to ₹25,000 (₹50,000 where one of them is a
senior citizen), and premiums for parents as a second deduction up to ₹25,000
(₹50,000 for a senior parent) — so up to ₹1,00,000 in all — with preventive
check-ups counted up to ₹5,000 across both, inside each group's ceiling. An
uninsured senior's medical bills are entered in that group's premium figure,
under the same ceiling. A declaration saved before migration 0059 had one 80D
figure; it is kept as the self-and-family one, and the parents' part has to be
entered again.

**Capital gains are computed, with caveats.** Realised gains from the portfolio
are sorted by asset class and holding period and taxed at their own rates —
12.5% above ₹1,25,000 on long-held listed equity (112A), 20% on short-held
(111A), 12.5% on gold, property and foreign shares held over 24 months (112)
— 12 months for a gold or international ETF listed in India, as for any listed
unit — and on debt-fund units bought before 1 April 2023 and held as long,
slab rates on other debt (s50AA) and on those held shorter. A share whose instrument
is international (or, with no region set, not in rupees) is never 111A/112A,
which are for equity listed in India. Listed equity bought before 1 February
2018 is grandfathered — its cost is the higher of what was paid and the lower
of its price on 31 January 2018 and the sale proceeds — where a price for that
day is recorded on the instrument; where none is, the parcel is reported as
unplaced rather than taxed on its whole gain. "Over 12 (or 24) months" is counted in calendar months, as the Act
words it, not days — bought 2024-02-28 and sold 2025-02-28 is exactly twelve
months and so short-term, though it is 366 days — and the sale preview, the
gains report and the estimate all use the same test. What the app cannot
place, it refuses to place: an instrument with no
asset class, a hybrid fund (whose treatment turns on an equity ratio not
tracked here), and a sale with no recorded lots are excluded from the
computation and reported on the screen instead of being guessed into a bucket.
A gain is the account holder's: a member's estimate takes sales from the
accounts they are named holder of, whoever else can see them. A sale in an
account with no holder is the sole member's in a one-member household and is
otherwise reported as unplaced until a holder is named.
Losses are floored at zero per bucket rather than set off between heads, so a
year with losses is overstated. The gains are measured against the rest of the
person's income the way the Act does it: the 87A ceiling and the surcharge
band are tested on total income including them; where other income is below
the basic exemption, the unused part is set against 111A, then 112, then 112A
gains (the order most favourable to the person — the Act fixes none); 87A never
relieves 112A tax, and under the new regime relieves no special-rate tax at
all; and the surcharge on special-rate tax stops at 15%. The basic-exemption
adjustment assumes a resident under 60 — the old regime's ₹3,00,000 and
₹5,00,000 senior limits are not modelled, so a senior's figure is overstated.

**Nothing is derived from the ledger except a starting figure.** Income is
prefilled from money that arrived in visible budget accounts, which is not
taxable income — it misses a salary paid elsewhere and includes receipts that
are not income at all. Deductions are entered, never inferred. The standard
deduction is set only against the gross income entered, which is the only
salary the estimate knows, and never exceeds it — gains alone earn none. The loan
interest report is still not carried in: it is cash paid across every loan. What
is carried is the accrued interest of loans marked as for a house, above.

**Charges are not interest.** A prepayment penalty or a foreclosure charge is a
cost of closing early, not interest on borrowed capital, and the interest report
excludes both. It did not always: the prepayment charge was stored with its
whole amount in the interest column, so a ₹2,000 penalty on a loan that had paid
no interest was reported as ₹2,000 of interest for the year — and counted twice
in the total cost of borrowing, once as interest and once as a fee. Fixed, with
migration 0042 correcting rows already written that way.

**Policies suggest; they do not declare.** The tax page offers what the
premiums of a member's own policies (those they are named holder of) come to
in the year, per 80C / 80D group — every premium falling due in the year,
paid or not. It does not spread a multi-year health premium across the years
it covers, cannot tell a premium paid in cash (which 80D excludes), and knows
nothing of 80C's other items. Applying it raises each figure to the policies'
and never lowers one; nothing is saved until the form is. A household policy
with no holder is nobody's deduction until one is named.

**Rates go stale.** Slabs change with each Finance Act. A year the app does not
have is refused rather than computed with the previous year's, and the health
page reports when the current financial year is newer than the rates carried.

## Currency

**Rupee by default.** `FEATURE_MULTI_CURRENCY` is off unless set. With it off,
accounts are assumed to be in the base currency.

**Conversion applies to valuation, not to budgeting.** A foreign-currency asset
account or holding is converted for net worth and allocation at the `fx_rates`
entry for the date requested. Budget accounts, envelopes and Ready to Assign are
single-currency.

**Missing rate.** Where no rate exists for a pair, the value is carried at 1 and
marked stale rather than dropped. A purchase or sale of a foreign instrument is the
exception: with no rate given and none stored for the trade date, it is refused.

## Import

**Payee names from PDF statements can contain spaces inside words.** Some
statement generators draw a single word as several positioned text runs; the
layout pass places each at the column its position implies, which can insert a
space. Roughly 29% of payee names extracted from one real corpus are affected —
`Fino P A Ym` for `Fino Pay`. Dates, amounts and table headers are read
correctly despite this; the residue is cosmetic and affects payee grouping.

The information needed to reconstruct the original word boundaries is not
present after layout. Approaches evaluated and rejected are recorded in
[archive/18-second-top-down.md](archive/18-second-top-down.md).

**Scanned statements cannot be read.** A PDF with no extractable text is
refused with an explanation. Use the bank's CSV.

**Four banks require a detail beyond name, date of birth and PAN** to derive a
statement password: SBI account statements need the registered mobile; SBI Card
and Canara need the card's last four digits; HSBC needs its last six. Without
them the file cannot be opened, and the interface says which is missing.

**Importing from YNAB or Actual Budget brings transactions only.** Budget
assignments, goals and targets are not read: they were worked out against the
other app's own balances and months, and copied into envelopes they would
count the same money twice. Amounts are taken as written, in whatever currency
the other budget used — nothing is converted. "Starting Balance" rows are left
out, since a Pathayam account has its own opening balance. Actual Budget's
column names are from memory of its export code, not checked against a file
it produced, so its columns are found by name and most are optional
[unverified]. An account is never created by an import: one without a
counterpart is left out until it is added, and the file imported again.

**No bank API connections.** There is no consumer open-banking surface in India
usable by a self-hosted application, and the application does not automate bank
logins.

**No SMS parsing.** It would require a device-side agent to forward message
bodies. iOS does not permit reading SMS at all.

**Gmail ingestion is opt-in and read-only**, restricted to recognised sender
addresses. It cannot be tested automatically because it requires a live grant.

## Offline and sync

**No offline mode — except entering a spend.** The application is
server-rendered and requires the server for everything it shows. There is no
local replica, no read cache, no service worker and no sync protocol. Installing
it as a PWA gives it an icon and a standalone window, not offline operation.

**The Add form can be used without signal** (`10` §3.7). An entry that cannot
reach the server is kept on the device with its idempotency key and sent when
the connection is back; a count shows on every page until it has gone. Its
limits:

- Only the Add form, and only with JavaScript. Transfers, edits, assigning and
  every other write still need the server.
- The page has to be open: there is no service worker, so nothing is sent in
  the background. It sends on the next page load, when the browser reports the
  connection is back, every thirty seconds while a page is visible, or on
  "Send now".
- The page itself has to have loaded once. With no signal at all, a fresh tab
  shows the browser's own offline page, not the form.
- The entry is checked when it arrives, against the budget as it is then. A
  refusal is kept with the server's message to correct or discard.
- An entry kept for more than six days is no longer sent automatically, because
  the server forgets idempotency keys after seven; the person is asked to check
  it was not already recorded.
- It is stored unencrypted in the browser, readable by anyone with the unlocked
  device until it is sent. Signing out clears it, and another member signing in
  discards it unsent.

## Scale

**Single process, single SQLite file.** Suitable for a household's ledger over
many years. There is no horizontal scaling story and none is intended.

**The rollup cache bounds month-opening cost**, but a query across the full
history reads the full history.

## Security boundaries

**The database is not encrypted at rest.** Anyone with the file has everything.

**Privacy between members is not an adversarial boundary.** It separates people
who trust each other and want some things kept personal. Any member can see the
household budget in full.

**No protection against a compromised host.** Sessions, tokens and data are all
readable with root.

## Operational

**Backups are local unless configured otherwise.** The scheduled job writes to
`BACKUP_DIR` on the same volume and verifies a restore. Copying backups off the
machine is the operator's responsibility.

**`HEARTBEAT_URL` is the only mechanism that can report the deployment being
down**, because every other alert originates from the deployment itself.

**Migrations are one-way.** There is no down-migration. Recovery from a bad
upgrade is restoring a backup.

## Interface

**No native mobile application.** The web interface is responsive and
installable.

**Printing is the browser's, not a generated PDF.** The tax estimate, reports,
month close, net worth statement and a loan's schedule print cleanly (black on
white, no navigation or controls, page numbers, a footer naming the household
and the date) through browser print or save-as-PDF; see
[screens](screens.md#printing). There is no server-side PDF, no letterhead, and
page breaks are the browser's best effort: a card taller than a page still
splits, between table rows. Page numbers need a browser that supports `@page`
margin boxes (current Chromium does); others print without them. Exports for
other software are CSV and JSON.

**English only.** Indian number formatting (lakh, crore) is used throughout for
figures.
