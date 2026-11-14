# Changelog

Versions follow [Semantic Versioning](https://semver.org/). From 1.0.0 on, the
HTTP API in [docs/API.md](docs/API.md), the configuration in
[docs/operations.md](docs/operations.md) and the database migrations are the
public surface: a change that breaks one of them is a major version.

## Unreleased

- **Indian shares and ETFs priced without a key.** A rupee share or ETF given
  its ISIN or its NSE symbol or BSE scrip code (new fields on the add form, and
  a "Where its price comes from" card on its holding page,
  `POST /portfolio/instrument/:id/identifier`) is priced each evening from the
  exchanges' public end-of-day files (bhavcopy): NSE's first, BSE's when NSE
  does not list it, dated by the trading day in the file. One download per
  exchange per day serves every holding, nothing about the holding is sent,
  and each exchange is asked at most twelve times a day. Alpha Vantage, when
  configured, remains for foreign shares and as the fallback for an instrument
  set up for it. The equity refresh now runs after 18:00 IST, once the files
  are out. New: `BHAVCOPY_PRICES` (default `true`). No migration.
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
- **Verification.** 2684 tests, including the accounting identity and the
  cache-against-ledger check over a 36-month household simulation.

Merged into this release: #1-#3 (engine, security, loan, import and UI fix
rounds), #5 (74 fixes from a top-down debug and UI pass), #6 (deposits,
offline entry, tax from the ledger, insurance, printing, YNAB/Actual import),
#7 (Gmail import fixes), #8 (net worth and foreign holdings), #9 (password
links), #10 (EMI GST, FY 2024-25 gains, listed bonds, net worth parts, Gmail
card digits), #11 (docs, website and API reference).

Known constraints are listed in [docs/limitations.md](docs/limitations.md).
