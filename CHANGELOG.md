# Changelog

Versions follow [Semantic Versioning](https://semver.org/). From 1.0.0 on, the
HTTP API in [docs/API.md](docs/API.md), the configuration in
[docs/operations.md](docs/operations.md) and the database migrations are the
public surface: a change that breaks one of them is a major version.

## Unreleased

- **The tax estimate treats AIS income as the Act does (#33).** With an AIS
  imported for the year, the saved gross income is split into salary (at least
  the AIS's salary, and anything typed above the AIS's figures) and the AIS's
  interest and dividends. The standard deduction is capped at that salary, so
  interest and dividends no longer get it: an interest-only ₹12,50,000 in
  2026-27 was shown ₹0 under the new regime and is now ₹52,000. Under the old
  regime, 80TTB (deposit interest, up to ₹50,000) is taken when the date of
  birth saved in Settings makes the member 60 or over in the year, and 80TTA
  (savings interest, up to ₹10,000) otherwise; the page says when no date of
  birth is saved. The new regime allows neither. Nothing new is stored. A
  member who also typed 80TTA into "Other deductions" should take it out.

- **Reports count card spending (#33).** "Income and spending" now measures
  Out as envelope spending, the same figure as the Overview's "Spent this
  month": a card purchase counts on the day it was made and paying the card
  is not counted again, so Net saved is no longer overstated. In is
  unchanged, and the card says what each line counts.

- **A card EMI's processing fee counts in its cost (#33).** The fee and its
  GST, still charged to the card, are also recorded against the plan as a
  charge, so the plan's "Total cost of borrowing" matches what the conversion
  said (₹3,234.82 on a ₹36,000, nine-month plan at 16% with a ₹299 fee, where
  it showed ₹2,882). Outstanding, net worth and spending are unchanged.
  Plans converted earlier keep their old total. No migration.

- **Prices every night, and a calmer Refresh button (#33).** Every instance,
  the demo included, refreshes every held price at 00:00 IST, within the same
  daily limits as any other refresh, and fetches nothing with
  `FEATURE_ASSETS` off. *Refresh prices* fetches at most once every five
  minutes per household, a limit that holds across a restart; a press sooner
  says when prices were last refreshed. On the demo the button fetches nothing
  and shows the prices the scheduled runs fetched. A share whose symbol the
  exchanges now list under a new ISIN, usually after a split, is no longer
  priced at the post-split close against pre-split units: its holding page
  asks for the units to be checked and the new ISIN put in.

- **"Back up now" waits ten minutes (#33).** A press within ten minutes of the
  newest backup takes no new copy and says when the last one was taken and
  when another can be, so repeated presses neither push out earlier days
  (self-host) nor pile up copies (hosted plans).

- **Fixes from a fresh review (#32).** A payee rule pattern built from many
  optional or bounded repeats (`\w{0,20}` eight times) is refused when saved,
  instead of stalling every import. A CSV with one very long narration no
  longer holds up the server, and neither does an AIS, CAS or SafeGold PDF
  with a long run of spaces. A share with an ISIN is looked up by ISIN on
  every exchange before any is asked for its symbol, so a BSE-only share whose
  ticker is another company's on NSE is no longer priced as that company. A
  loan with nothing drawn yet no longer says it is paid off. Prices such as
  ₹1,108.60 show two decimals rather than four. The AI connector's tax
  estimate leaves out the tax-free gains list when `FEATURE_ASSETS` is off,
  as the Tax page does.

- **Tax-free long-term gains left this year.** The Tax page shows, for the
  year in progress, how much of the ₹1,25,000 s112A exemption the member has
  used on long-term listed equity, what is left, and the days to 31 March; and
  for each listed equity holding of their own, the lots already long-term at
  the latest stored price and how many units could be sold, oldest lots first,
  without crossing what is left. Unlisted shares, hybrid funds, international
  holdings and anything without a price are listed as left out, never
  suggested. Portfolio links to it, and the AI connector's `tax_estimate`
  carries it as `ltcg_harvest`. No migration.

- **The tax estimate reads your Annual Information Statement.** On the Tax
  page, upload your own AIS PDF (it opens with your saved PAN and date of
  birth): TDS by deductor, salary, interest from savings and deposits,
  dividends and securities sold are read and shown, with the sales set beside
  what the app recorded. "Use these figures" raises the form's TDS and gross
  income to the AIS's, never lowers them, and saves nothing until you do. Only
  the figures are kept, never the file, and only for you. JSON and CSV
  downloads are not read; the PDF reader is checked against real
  statements for 2024-25 to 2026-27 (the Income-tax Act, 2025's codes and
  "Tax Year" heading included), and anything not recognised is listed as not read, TCS lines among them: tax collected at
  source is never counted as TDS. Refused on the demo. Migration 0077. See
  [docs/limitations.md](docs/limitations.md#tax).

- **Indian shares and ETFs priced without a key.** A rupee share or ETF given
  its ISIN or its NSE symbol or BSE scrip code (new fields on the add form, and
  a "Where its price comes from" card on its holding page,
  `POST /portfolio/instrument/:id/identifier`) is priced each evening from the
  exchanges' public end-of-day files (bhavcopy): NSE's first, BSE's when NSE
  does not list it, dated by the trading day in the file. One download per
  exchange per day serves every holding, nothing about the holding is sent,
  and each exchange is asked at most twelve times a day by one running server
  (the count is kept in memory and starts again on a restart). Alpha Vantage, when
  configured, remains for foreign shares and as the fallback for an instrument
  set up for it. The equity refresh now runs after 18:00 IST, once the files
  are out. New: `BHAVCOPY_PRICES` (default `true`). No migration.

- **A top-down pass through the app (#27).** 31 fixes from a review of every
  screen, and ten decisions taken with it. A private loan's payment envelope
  lives in its holder's own budget (moved by `setLoanVisibility`, and at
  startup for loans already private). Statement, CAS, SafeGold and AIS PDFs are
  read in a worker thread with a 10-second deadline and a 256 MB heap, one at a
  time; a second upload is told to try again, and on the demo waits its turn,
  at most five per address. A private payee nobody uses any more is no longer
  listed to other members (migration 0076). A "matches a pattern" rule that
  could backtrack for minutes is refused when saved. Reconciling a card or loan
  asks how much the statement says you owe; a move larger than an envelope
  holds is refused unless "Allow it to go below zero" is ticked; payments clear
  a card's opening balance first; a goal's monthly figure starts from what was
  saved at the start of the month; the FIRE target waits for 30 days of
  history; the tax page names the accounts its starting gross was summed from.
  The demo household now carries an AIS, a tax-free gains suggestion,
  exchange-priced holdings and a private loan.

- **Forwarding address.** Each member can have an address
  (`<route>.<token>@INBOUND_DOMAIN`) to forward bank mail to with a filter;
  alerts and statements land in Review as they arrive, through the Gmail
  import's own path. Only known bank senders with a valid DKIM signature are
  read; locked statements wait, sealed, for a password; everything forwarded
  is purged at 90 days. A receive-only SMTP server with no dependencies
  (`src/mx`, `fly.mx.toml`, compose profile `mail`) hands each message over
  signed with `INBOUND_SECRET`. New: `FEATURE_FORWARDING` (on for selfhost, off
  in the hosted presets), `INBOUND_DOMAIN`, `INBOUND_ROUTE`, `INBOUND_SECRET`,
  migration 0074. See [docs/forwarding.md](docs/forwarding.md).
- **Let's Encrypt, renewed on its own.** The mail receiver gets a certificate
  for `MX_TLS_ACME_DOMAIN` and offers `STARTTLS` with it, so forwarded bank mail
  no longer crosses the internet in clear. A self-hosted app facing the
  internet without a proxy can do the same for HTTPS with `TLS_ACME_DOMAIN`
  (off by default; the hosted apps are unchanged). The domain is proved with a
  DNS record made through Cloudflare (`CLOUDFLARE_API_TOKEN`); the certificate
  is checked every 12 hours, renewed with 30 days left, and swapped in without
  a restart. New: `MX_TLS_ACME_DOMAIN`, `TLS_ACME_DOMAIN`, `HTTPS_PORT`,
  `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ZONE_ID`, `ACME_EMAIL`,
  `ACME_DIRECTORY`, `ACME_DIR`. See [docs/forwarding.md](docs/forwarding.md#tls-for-the-receiver)
  and [docs/operations.md](docs/operations.md#https-without-a-proxy).
- **The mail receiver keeps to its means.** It asks the app whether an address
  is in use before taking any data (`POST /inbound/check`, signed with
  `INBOUND_SECRET`), holds at most 96 MiB of mail across all sessions, takes 20
  sessions at once and 3 from one address, and ends any session after ten
  minutes; a sender over a limit is told to retry later. The app refuses an
  unsigned hand-off before reading its body and reads four at once. New:
  `MX_MEMORY_BYTES`, `MX_MAX_CONNECTIONS`, `MX_MAX_CONNECTIONS_PER_IP`,
  `MX_SESSION_SECONDS`, `MX_PROXY_PROTOCOL`, `MX_CHECK_RECIPIENTS`.

## 1.0.0 · 24-10-2026

First production release. Everything built since 19-09-2026, in one version.

- **Budgeting.** Zero-based envelope budgeting with rollover, two household-wide
  overspend models, targets, month closes, and credit-card payment envelopes
  that report how much of a card balance no envelope funds.
- **Money in.** CSV, YNAB and Actual Budget import; statement PDFs from twelve
  banks with derived passwords; Gmail statement and alert import; UPI narration
  parsing; duplicate detection and rules. Offline entry from the Add form.
- **Loans and assets.** Reducing-balance and flat loans, rate changes,
  prepayment comparison, EMI conversion with GST on interest; lending; FD, RD,
  PPF and EPF that value themselves; insurance; CAS portfolio import, listed
  bonds, foreign holdings; net worth; realised gains and tax by financial year;
  a financial-independence projection.
- **Household.** Per-member visibility, password, OpenID Connect or Google
  sign-in, one-time password links for members without a password, access
  tokens, printing.
- **Operations.** Server-only, SQLite, no runtime dependencies, 67 migrations,
  backups with restore verification, `/healthz`, Docker and Fly.io deploys.
  `/healthz` and the Health screen now report the version from one constant.
- **Verification.** The test suite includes the accounting identity and the
  cache-against-ledger check over a 36-month household simulation.

Merged into this release: #1-#3 (engine, security, loan, import and UI fix
rounds), #5 (74 fixes from a top-down debug and UI pass), #6 (deposits,
offline entry, tax from the ledger, insurance, printing, YNAB/Actual import),
#7 (Gmail import fixes), #8 (net worth and foreign holdings), #9 (password
links), #10 (EMI GST, FY 2024-25 gains, listed bonds, net worth parts, Gmail
card digits), #11 (docs, website and API reference).

Known constraints are listed in [docs/limitations.md](docs/limitations.md).
