# Limitations

Known constraints of the current build.

## Budgeting

**Past months are recomputed, not frozen.** Viewing an earlier month applies
current data, including assignments made in later months. A past month's Ready
to Assign can therefore read lower than it did at the time. Closed months record
their figures in `month_closes`, which is the durable record. See
[dev/01-engine-derivation.md](dev/01-engine-derivation.md) §4.

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
the window is annualised from what exists and the screen says so, but one
unusual month still moves the target a long way.

## Tax

**It is an estimate, not a return.** Arithmetic on figures the person enters,
under the slabs the app carries. It files nothing, it is not advice, and it is
not a substitute for an accountant.

**What it does not model**, each of which changes the answer: marginal relief
on surcharge and on the 87A cliff, so a figure just over a threshold is
overstated; tax already deducted at source; losses set off between heads or
carried forward, and house property loss; clubbing; foreign income and treaty
relief; presumptive schemes under 44AD and 44ADA.

**Capital gains are computed, with caveats.** Realised gains from the portfolio
are sorted by asset class and holding period and taxed at their own rates —
12.5% above ₹1,25,000 on long-held listed equity (112A), 20% on short-held
(111A), 12.5% on gold and property held over 24 months (112), slab rates on
debt. "Over 12 (or 24) months" is counted in calendar months, as the Act
words it, not days — bought 2024-02-28 and sold 2025-02-28 is exactly twelve
months and so short-term, though it is 366 days — and the sale preview, the
gains report and the estimate all use the same test. What the app cannot
place, it refuses to place: an instrument with no
asset class, a hybrid fund (whose treatment turns on an equity ratio not
tracked here), and a sale with no recorded lots are excluded from the
computation and reported on the screen instead of being guessed into a bucket.
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
are not income at all. Deductions are entered, never inferred. The loan
interest report is deliberately not carried in: section 24(b) wants accrued
interest on a specific property, which is a different number from cash paid
across every loan.

**Charges are not interest.** A prepayment penalty or a foreclosure charge is a
cost of closing early, not interest on borrowed capital, and the interest report
excludes both. It did not always: the prepayment charge was stored with its
whole amount in the interest column, so a ₹2,000 penalty on a loan that had paid
no interest was reported as ₹2,000 of interest for the year — and counted twice
in the total cost of borrowing, once as interest and once as a fee. Fixed, with
migration 0042 correcting rows already written that way.

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
marked stale rather than dropped.

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

**No bank API connections.** There is no consumer open-banking surface in India
usable by a self-hosted application, and the application does not automate bank
logins.

**No SMS parsing.** It would require a device-side agent to forward message
bodies. iOS does not permit reading SMS at all.

**Gmail ingestion is opt-in and read-only**, restricted to recognised sender
addresses. It cannot be tested automatically because it requires a live grant.

## Offline and sync

**No offline mode.** The application is server-rendered and requires the server.
There is no local replica and no sync protocol. Installing it as a PWA gives it
an icon and a standalone window, not offline operation.

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

**No printing stylesheet.** Exports are CSV and JSON.

**English only.** Indian number formatting (lakh, crore) is used throughout for
figures.
