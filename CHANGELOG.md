# Changelog

Versions follow [Semantic Versioning](https://semver.org/). From 1.0.0 on, the
HTTP API in [docs/API.md](docs/API.md), the configuration in
[docs/operations.md](docs/operations.md) and the database migrations are the
public surface: a change that breaks one of them is a major version.

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
