/**
 * Schema migrations.
 *
 * Each entry is applied once, in order, inside a transaction, and its index+1
 * becomes `user_version`. Migrations are append-only: never edit one that has
 * shipped, add another.
 *
 * Amounts are integer paise (see core/money.ts). Dates are "YYYY-MM-DD" and
 * months are "YYYY-MM" (see core/dates.ts). Timestamps are ISO strings with an
 * IST offset.
 */

export interface Migration {
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    name: "0001-initial",
    sql: `
--------------------------------------------------------------------------------
-- Household, members and identity (F1, R38)
--------------------------------------------------------------------------------

-- Exactly one row. The household's single shared budget (02 §3).
CREATE TABLE household (
  id                      INTEGER PRIMARY KEY CHECK (id = 1),
  name                    TEXT    NOT NULL DEFAULT 'Household',
  base_currency           TEXT    NOT NULL DEFAULT 'INR',
  -- Q1: both overspend models ship. 'reduce-rta' is Actual's, the default.
  overspend_model         TEXT    NOT NULL DEFAULT 'reduce-rta'
                                  CHECK (overspend_model IN ('reduce-rta','carry-negative')),
  -- R13.5 / Q6: off by default. The monthly sit-down stays a deliberate act.
  auto_assign_on_rollover INTEGER NOT NULL DEFAULT 0,
  first_day_of_week       INTEGER NOT NULL DEFAULT 1,
  fiscal_year_start_month INTEGER NOT NULL DEFAULT 4,
  -- F8.3: warn this many days before a card due date with an unfunded shortfall.
  card_due_warning_days   INTEGER NOT NULL DEFAULT 5,
  setup_completed_at      TEXT,
  created_at              TEXT    NOT NULL
);

CREATE TABLE members (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  google_sub    TEXT UNIQUE,
  avatar_url    TEXT,
  -- R39.1: follow system by default, stored server-side so the first response
  -- can render the resolved theme and there is no flash of the wrong one.
  theme         TEXT NOT NULL DEFAULT 'system' CHECK (theme IN ('light','dark','system')),
  -- F1.2: the allow-list. A member row may exist before its first sign-in.
  allowed        INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL,
  last_seen_at   TEXT,
  -- F1.6: removable, but historical attributions are retained.
  removed_at     TEXT
);

CREATE TABLE sessions (
  id             TEXT PRIMARY KEY,
  member_id      TEXT NOT NULL REFERENCES members(id),
  created_at     TEXT NOT NULL,
  last_seen_at   TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  user_agent     TEXT,
  ip_hint        TEXT,
  revoked_at     TEXT,
  -- R38.6-R38.12: "view as". Read-only unless writes are explicitly enabled
  -- for the session, and always expiring.
  impersonating_member_id TEXT REFERENCES members(id),
  impersonation_writes    INTEGER NOT NULL DEFAULT 0,
  impersonation_expires_at TEXT
);
CREATE INDEX idx_sessions_member ON sessions(member_id) WHERE revoked_at IS NULL;

-- F30: personal API tokens. The secret is stored only as a hash (F30.4).
CREATE TABLE api_tokens (
  id           TEXT PRIMARY KEY,
  member_id    TEXT NOT NULL REFERENCES members(id),
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  scope        TEXT NOT NULL CHECK (scope IN ('read','read-write')),
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  expires_at   TEXT,
  revoked_at   TEXT
);

-- R38.16: failed authentication is rate-limited per source.
CREATE TABLE auth_attempts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  source     TEXT NOT NULL,
  at         TEXT NOT NULL,
  outcome    TEXT NOT NULL,
  detail     TEXT
);
CREATE INDEX idx_auth_attempts ON auth_attempts(source, at);

--------------------------------------------------------------------------------
-- R37 · The event log — append-only, immutable, attributed
--------------------------------------------------------------------------------

CREATE TABLE events (
  seq                INTEGER PRIMARY KEY AUTOINCREMENT,
  id                 TEXT NOT NULL UNIQUE,
  at                 TEXT NOT NULL,
  -- The member the action is attributed to. When impersonating, real_member_id
  -- is the person actually at the keyboard (R38.9) — the trail never loses it.
  actor_member_id    TEXT REFERENCES members(id),
  real_member_id     TEXT REFERENCES members(id),
  source             TEXT NOT NULL
                     CHECK (source IN ('ui','import','rule','schedule','api','job','system')),
  -- Names the rule or job responsible for an automated write (R37.6).
  source_detail      TEXT,
  entity             TEXT NOT NULL,
  entity_id          TEXT,
  action             TEXT NOT NULL,
  before_json        TEXT,
  after_json         TEXT,
  summary            TEXT,
  idempotency_key    TEXT,
  -- R37.2: a correction is a new event. These columns link them, and never
  -- edit or remove the original.
  undo_of_event_id   TEXT,
  undone_by_event_id TEXT
);
CREATE INDEX idx_events_entity ON events(entity, entity_id, seq);
CREATE INDEX idx_events_at     ON events(at);
CREATE INDEX idx_events_actor  ON events(actor_member_id, seq);

--------------------------------------------------------------------------------
-- R36 · Idempotency
--------------------------------------------------------------------------------

CREATE TABLE idempotency_keys (
  key          TEXT NOT NULL,
  -- R36.4: scoped to the member, so two members cannot collide.
  member_id    TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('in-progress','done')),
  status_code  INTEGER,
  response_json TEXT,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (key, member_id)
);
CREATE INDEX idx_idem_created ON idempotency_keys(created_at);

--------------------------------------------------------------------------------
-- Accounts (F2)
--------------------------------------------------------------------------------

CREATE TABLE accounts (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  -- F2.9: the household's nickname, distinct from the bank's own name.
  nickname     TEXT,
  -- 'budget' balances fund the budget; 'credit' spending creates a liability
  -- and consumes envelope money (R6); 'tracking' does neither (F18.g).
  kind         TEXT NOT NULL CHECK (kind IN ('budget','credit','tracking')),
  subtype      TEXT NOT NULL,
  institution  TEXT,
  -- F2.9: matched against SMS and email alerts.
  last4        TEXT,
  currency     TEXT NOT NULL DEFAULT 'INR',
  opening_balance INTEGER NOT NULL DEFAULT 0,
  opening_date TEXT NOT NULL,
  -- R6 India specifics: statement cycles are not calendar months.
  statement_day INTEGER,
  due_day       INTEGER,
  credit_limit  INTEGER,
  sort          INTEGER NOT NULL DEFAULT 0,
  -- F2.7: closeable without deletion; history is retained.
  closed_at     TEXT,
  created_at    TEXT NOT NULL,
  created_by    TEXT REFERENCES members(id)
);

-- R6.a: an add-on card is a sub-card of a Credit account, never an account of
-- its own. The primary card is a row here too, so every transaction can name
-- the card it was made on (R6.c).
CREATE TABLE cards (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES accounts(id),
  label           TEXT NOT NULL,
  last4           TEXT,
  is_primary      INTEGER NOT NULL DEFAULT 0,
  -- The member who holds this card; defaults the owner of its transactions
  -- (R6.e), which is what keeps the ownership model honest.
  holder_member_id TEXT REFERENCES members(id),
  -- R6.g: a limit belongs to the account. Any per-add-on cap is a note.
  spend_cap_note  TEXT,
  -- R6.f: closing an add-on does not close the account or its payment category.
  closed_at       TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_cards_account ON cards(account_id);
CREATE INDEX idx_cards_last4   ON cards(last4);

--------------------------------------------------------------------------------
-- Categories (F3)
--------------------------------------------------------------------------------

CREATE TABLE category_groups (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  -- 'credit-payments' and 'loan-payments' groups are created by the app and
  -- hold payment categories, which cannot be deleted while their account lives.
  kind      TEXT NOT NULL DEFAULT 'normal'
            CHECK (kind IN ('normal','credit-payments','loan-payments','internal')),
  sort      INTEGER NOT NULL DEFAULT 0,
  hidden_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE categories (
  id         TEXT PRIMARY KEY,
  group_id   TEXT NOT NULL REFERENCES category_groups(id),
  name       TEXT NOT NULL,
  sort       INTEGER NOT NULL DEFAULT 0,
  -- F3.2: a hidden category keeps its balance and history but leaves
  -- auto-assign and the underfunded total.
  hidden_at  TEXT,
  deleted_at TEXT,
  note       TEXT,
  -- Set on a payment category, linking it to the Credit account it settles
  -- (R6). Its activity is derived from that account, never stored.
  payment_account_id TEXT REFERENCES accounts(id),
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_categories_payment_account
  ON categories(payment_account_id) WHERE payment_account_id IS NOT NULL;
CREATE INDEX idx_categories_group ON categories(group_id);

-- The atomic budgeting act. One row per (month, category) holding the net
-- assigned figure; the event log holds how it got there (R37.3 permits a
-- materialised state that is reconstructible from the log).
CREATE TABLE assignments (
  month       TEXT NOT NULL,
  category_id TEXT NOT NULL REFERENCES categories(id),
  amount      INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (month, category_id)
);

-- R11: income explicitly set aside for the following month.
CREATE TABLE held_for_next_month (
  month      TEXT PRIMARY KEY,
  amount     INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

-- R8: at most one target per category.
CREATE TABLE targets (
  category_id  TEXT PRIMARY KEY REFERENCES categories(id),
  type         TEXT NOT NULL CHECK (type IN (
                 'monthly','refill','refill-hold','spending-period',
                 'by-date','by-date-repeating','debt-payoff','schedule-linked')),
  amount       INTEGER,
  target_date  TEXT,
  period       TEXT CHECK (period IN ('day','week','month')),
  schedule_id  TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);


--------------------------------------------------------------------------------
-- Payees (F5)
--------------------------------------------------------------------------------

CREATE TABLE payees (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  -- Dropped again in 0020: it was never written or read, and payeeStats derives
  -- the same answer from the ledger. Kept here so that migration has a column
  -- to drop on a database created from scratch.
  default_category_id TEXT REFERENCES categories(id),
  default_account_id  TEXT REFERENCES accounts(id),
  -- F5.2: merging preserves history by pointing the loser at the winner
  -- rather than deleting it.
  merged_into_id      TEXT REFERENCES payees(id),
  created_at          TEXT NOT NULL
);
CREATE INDEX idx_payees_name ON payees(name);

-- P4 / F5.1: every raw string ever mapped to this payee, kept forever.
CREATE TABLE payee_aliases (
  id         TEXT PRIMARY KEY,
  payee_id   TEXT NOT NULL REFERENCES payees(id),
  raw        TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_payee_alias_raw ON payee_aliases(raw);

--------------------------------------------------------------------------------
-- Transactions (F4)
--------------------------------------------------------------------------------

CREATE TABLE transactions (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id),
  -- R6.c: which physical card this was made on, so add-on spending is not
  -- silently attributed to the primary holder.
  card_id     TEXT REFERENCES cards(id),
  date        TEXT NOT NULL,
  -- Signed paise relative to this account. Negative = money left it.
  amount      INTEGER NOT NULL,
  payee_id    TEXT REFERENCES payees(id),
  -- NULL when split, when a transfer leg, or when genuinely uncategorised
  -- (which F4.1 flags as needing attention).
  category_id TEXT REFERENCES categories(id),
  is_split    INTEGER NOT NULL DEFAULT 0,
  memo        TEXT,
  cleared     INTEGER NOT NULL DEFAULT 0,
  -- H2: who spent it, defaulting to the entering member, editable.
  owner_member_id TEXT REFERENCES members(id),
  -- Groups the two legs of a transfer. A transfer to a Credit account is a
  -- card payment (F4.4, R6).
  transfer_pair_id TEXT,
  reimbursable  INTEGER NOT NULL DEFAULT 0,
  source        TEXT NOT NULL DEFAULT 'manual'
                CHECK (source IN ('manual','csv','pdf','email','sms','api','schedule')),
  import_batch_id TEXT,
  -- Guarantees I5: re-importing the same file creates nothing new.
  source_id     TEXT,
  -- P4 / N4: the original record is never overwritten.
  raw_payee     TEXT,
  raw_amount    TEXT,
  raw_date      TEXT,
  raw_narration TEXT,
  -- 04 §6.5: auto-approved rows stay visually marked in the register for 7 days.
  auto_approved_at TEXT,
  created_at    TEXT NOT NULL,
  created_by    TEXT REFERENCES members(id),
  updated_at    TEXT NOT NULL,
  -- F4.8: soft for 30 days with restore, then hard.
  deleted_at    TEXT
);
CREATE INDEX idx_tx_account_date ON transactions(account_id, date) WHERE deleted_at IS NULL;
CREATE INDEX idx_tx_category     ON transactions(category_id, date) WHERE deleted_at IS NULL;
CREATE INDEX idx_tx_date         ON transactions(date) WHERE deleted_at IS NULL;
CREATE INDEX idx_tx_payee        ON transactions(payee_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_tx_transfer     ON transactions(transfer_pair_id);
CREATE UNIQUE INDEX idx_tx_source_id ON transactions(source, source_id)
  WHERE source_id IS NOT NULL;

-- F4.3: splits across unlimited categories, summing to the transaction total.
CREATE TABLE transaction_splits (
  id             TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  category_id    TEXT REFERENCES categories(id),
  amount         INTEGER NOT NULL,
  memo           TEXT,
  sort           INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_splits_tx       ON transaction_splits(transaction_id);
CREATE INDEX idx_splits_category ON transaction_splits(category_id);

--------------------------------------------------------------------------------
-- Tags (F12)
--------------------------------------------------------------------------------

CREATE TABLE tags (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  -- F12.4: an optional amount turns a trip tag into an ad-hoc budget without
  -- touching the envelope tree.
  budget_amount INTEGER,
  starts_on  TEXT,
  ends_on    TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE transaction_tags (
  transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  tag_id         TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (transaction_id, tag_id)
);
CREATE INDEX idx_tx_tags_tag ON transaction_tags(tag_id);

--------------------------------------------------------------------------------
-- Import, review queue and rules (F6, F13, 04)
--------------------------------------------------------------------------------

-- IL1: every import is a batch with a log and a single-action undo.
CREATE TABLE import_batches (
  id            TEXT PRIMARY KEY,
  source        TEXT NOT NULL,
  adapter       TEXT NOT NULL,
  account_id    TEXT REFERENCES accounts(id),
  file_name     TEXT,
  member_id     TEXT REFERENCES members(id),
  created_at    TEXT NOT NULL,
  rows_read     INTEGER NOT NULL DEFAULT 0,
  created_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  auto_approved_count INTEGER NOT NULL DEFAULT 0,
  error_count   INTEGER NOT NULL DEFAULT 0,
  errors_json   TEXT,
  undone_at     TEXT
);

-- 04 §3.2: saved per bank+account, auto-detected by header signature.
CREATE TABLE import_profiles (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  account_id       TEXT REFERENCES accounts(id),
  header_signature TEXT,
  mapping_json     TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  last_used_at     TEXT
);

-- I2: nothing enters the ledger from an automated source without confirmation
-- or an explicit auto-approve rule. This is where imported rows wait.
CREATE TABLE staged_transactions (
  id              TEXT PRIMARY KEY,
  batch_id        TEXT NOT NULL REFERENCES import_batches(id),
  account_id      TEXT NOT NULL REFERENCES accounts(id),
  card_id         TEXT REFERENCES cards(id),
  row_number      INTEGER,
  date            TEXT NOT NULL,
  amount          INTEGER NOT NULL,
  -- I1: the raw record, retained unchanged forever.
  raw_narration   TEXT,
  raw_payee       TEXT,
  raw_amount      TEXT,
  raw_date        TEXT,
  source_id       TEXT,
  reference       TEXT,
  -- Proposed values from the rules engine, all of them suggestions (N9).
  payee_id        TEXT REFERENCES payees(id),
  proposed_payee  TEXT,
  category_id     TEXT REFERENCES categories(id),
  memo            TEXT,
  tags_json       TEXT,
  owner_member_id TEXT REFERENCES members(id),
  applied_rules_json TEXT,
  -- Set when dedupe suspects this is already in the ledger (04 §4).
  duplicate_of_id TEXT REFERENCES transactions(id),
  duplicate_tier  TEXT CHECK (duplicate_tier IN ('strong','probable','weak','manual-vs-imported')),
  duplicate_reason TEXT,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','rejected','merged')),
  resolved_at     TEXT,
  resolved_by     TEXT REFERENCES members(id),
  transaction_id  TEXT REFERENCES transactions(id),
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_staged_status ON staged_transactions(status, created_at);
CREATE INDEX idx_staged_batch  ON staged_transactions(batch_id);

CREATE TABLE rules (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  -- R-E1: three ordered stages. Within a stage rules are auto-ordered
  -- least-specific to most-specific (R-E2) — users never hand-order them.
  stage           TEXT NOT NULL CHECK (stage IN ('pre','default','post')),
  conditions_json TEXT NOT NULL,
  actions_json    TEXT NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 1,
  -- L1/L2: a rule proposed by the app from behaviour, awaiting confirmation.
  proposed        INTEGER NOT NULL DEFAULT 0,
  dismissed_at    TEXT,
  times_applied   INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  created_by      TEXT REFERENCES members(id)
);
CREATE INDEX idx_rules_stage ON rules(stage, enabled);

-- R-E4 / F6.8: which rules touched a transaction, shown in its details pane.
CREATE TABLE rule_applications (
  transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  rule_id        TEXT NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
  at             TEXT NOT NULL,
  PRIMARY KEY (transaction_id, rule_id)
);

-- S4: the one destination for everything needing a human. Item kinds beyond
-- imports (overspent, unfunded card, broken checkpoint, proposed rule) are
-- computed live rather than stored; this table holds only what must persist —
-- chiefly dismissals, which are remembered.
CREATE TABLE review_dismissals (
  kind       TEXT NOT NULL,
  ref        TEXT NOT NULL,
  at         TEXT NOT NULL,
  member_id  TEXT REFERENCES members(id),
  PRIMARY KEY (kind, ref)
);

--------------------------------------------------------------------------------
-- Reconciliation (F9, and the Q5 breakage rule in 09 §5)
--------------------------------------------------------------------------------

CREATE TABLE reconciliations (
  id            TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL REFERENCES accounts(id),
  as_of         TEXT NOT NULL,
  bank_balance  INTEGER NOT NULL,
  app_balance   INTEGER NOT NULL,
  adjustment_transaction_id TEXT REFERENCES transactions(id),
  created_at    TEXT NOT NULL,
  created_by    TEXT REFERENCES members(id),
  -- R7.c: marked broken when something on or before as_of is edited, and
  -- never silently repaired (R7.f).
  broken_at     TEXT,
  broken_reason TEXT
);
CREATE INDEX idx_recon_account ON reconciliations(account_id, as_of);

--------------------------------------------------------------------------------
-- Schedules (F7) — declared here in P0 because schedule-linked targets (R8)
-- and the loan/EMI obligations reference them. The calendar itself is P1.
--------------------------------------------------------------------------------

CREATE TABLE schedules (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  account_id   TEXT REFERENCES accounts(id),
  payee_id     TEXT REFERENCES payees(id),
  category_id  TEXT REFERENCES categories(id),
  amount       INTEGER,
  amount_is_estimate INTEGER NOT NULL DEFAULT 0,
  recurrence   TEXT NOT NULL,
  next_due     TEXT,
  short_month_policy TEXT NOT NULL DEFAULT 'last-day'
               CHECK (short_month_policy IN ('last-day','skip','next-day')),
  auto_post    INTEGER NOT NULL DEFAULT 0,
  is_subscription INTEGER NOT NULL DEFAULT 0,
  -- F7.8: detected-but-unconfirmed schedules are distinguished from confirmed.
  detected     INTEGER NOT NULL DEFAULT 0,
  confidence   TEXT,
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL
);

--------------------------------------------------------------------------------
-- Operations (F26, F27)
--------------------------------------------------------------------------------

CREATE TABLE job_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job         TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  status      TEXT NOT NULL CHECK (status IN ('running','ok','failed','skipped')),
  detail      TEXT
);
CREATE INDEX idx_job_runs ON job_runs(job, started_at);

CREATE TABLE settings_kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`,
  },
  {
    name: "0002-loans",
    sql: `
--------------------------------------------------------------------------------
-- F18 · Loans (06-loans.md). Promoted to P1 by 10 §2 E9.
--
-- A loan is a specialisation of a Tracking account, which is what makes
-- F18.g structural: to_budget only ever counts Budget accounts, so a
-- liability can never reach Ready to Assign.
--------------------------------------------------------------------------------

CREATE TABLE loans (
  id                   TEXT PRIMARY KEY,
  account_id           TEXT NOT NULL REFERENCES accounts(id),
  lender               TEXT NOT NULL,
  nickname             TEXT,
  loan_type            TEXT NOT NULL,
  -- R14: sanctioned, disbursed and undrawn are three distinct figures.
  -- Only disbursed is a liability.
  sanctioned           INTEGER NOT NULL,
  sanction_date        TEXT NOT NULL,
  -- R16: fixed per loan at creation, changeable only with an explicit recompute.
  interest_model       TEXT NOT NULL DEFAULT 'reducing'
                       CHECK (interest_model IN
                         ('reducing','flat','moratorium-serviced','moratorium-capitalised')),
  benchmark            TEXT,
  tenure_months        INTEGER NOT NULL,
  first_instalment_date TEXT,
  instalment_day       INTEGER,
  repayment_account_id TEXT REFERENCES accounts(id),
  -- R14: the loan's own envelope, symmetric with a card's (R6). Cannot be
  -- deleted while the loan is open.
  payment_category_id  TEXT REFERENCES categories(id),
  -- R14/R22.3: set when the loan predates the app, so lifetime figures are
  -- labelled "from DD-MM-YYYY" rather than presented as complete.
  history_from         TEXT,
  -- R14: a loan created mid-life has no tranche records, but it is not
  -- undrawn. This is what was already disbursed when the loan was added,
  -- so "undrawn" does not report the whole sanction as available.
  disbursed_at_creation INTEGER NOT NULL DEFAULT 0,
  closed_at            TEXT,
  created_at           TEXT NOT NULL,
  created_by           TEXT REFERENCES members(id)
);
CREATE INDEX idx_loans_account ON loans(account_id);

-- R15: each release of principal, with a destination. The destination is the
-- whole point: a tranche paid to a builder must never look like spendable money.
CREATE TABLE loan_disbursements (
  id                     TEXT PRIMARY KEY,
  loan_id                TEXT NOT NULL REFERENCES loans(id),
  date                   TEXT NOT NULL,
  amount                 INTEGER NOT NULL,
  destination            TEXT NOT NULL CHECK (destination IN ('budget-account','third-party')),
  destination_account_id TEXT REFERENCES accounts(id),
  note                   TEXT,
  created_at             TEXT NOT NULL
);
CREATE INDEX idx_disbursements_loan ON loan_disbursements(loan_id, date);

-- R16/R20.1: a rate change is a new dated period, never an edit to the old one.
CREATE TABLE loan_rates (
  id              TEXT PRIMARY KEY,
  loan_id         TEXT NOT NULL REFERENCES loans(id),
  effective_from  TEXT NOT NULL,
  annual_rate_pct REAL NOT NULL,
  note            TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_loan_rates ON loan_rates(loan_id, effective_from);

-- R18: recorded actuals. Authoritative for the outstanding balance, which is
-- why the projection re-anchors to these rather than the reverse.
CREATE TABLE loan_payments (
  id             TEXT PRIMARY KEY,
  loan_id        TEXT NOT NULL REFERENCES loans(id),
  date           TEXT NOT NULL,
  amount         INTEGER NOT NULL,
  principal      INTEGER NOT NULL,
  interest       INTEGER NOT NULL,
  -- R18.3: an estimated split stays visually distinct from a confirmed one.
  estimated      INTEGER NOT NULL DEFAULT 0,
  kind           TEXT NOT NULL DEFAULT 'instalment'
                 CHECK (kind IN ('instalment','prepayment','extra','charge','foreclosure')),
  transaction_id TEXT REFERENCES transactions(id),
  note           TEXT,
  created_at     TEXT NOT NULL,
  created_by     TEXT REFERENCES members(id)
);
CREATE INDEX idx_loan_payments ON loan_payments(loan_id, date);

-- R18.8 · Loan reconciliation against a lender statement.
--
-- Drift (R18.4) is only meaningful against a balance the *lender* stated.
-- Comparing the projection to our own ledger would report every extra payment
-- as drift, which is the household doing something deliberate rather than the
-- projection going wrong.
CREATE TABLE loan_statements (
  id                 TEXT PRIMARY KEY,
  loan_id            TEXT NOT NULL REFERENCES loans(id),
  as_of              TEXT NOT NULL,
  lender_outstanding INTEGER NOT NULL,
  interest_paid_ytd  INTEGER,
  instalments_remaining INTEGER,
  -- The app's own figure at the time, kept so the drift can be reasoned about.
  app_outstanding    INTEGER NOT NULL,
  resolved           INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL,
  created_by         TEXT REFERENCES members(id)
);
CREATE INDEX idx_loan_statements ON loan_statements(loan_id, as_of);
`,
  },
  {
    name: "0003-goals",
    sql: `
--------------------------------------------------------------------------------
-- F11 · Goals (piggy banks).
--
-- A goal holds no money of its own. Progress is the combined balance of the
-- categories it is linked to, so the goal screen and the budget screen can
-- never report different figures for the same rupees.
--------------------------------------------------------------------------------

CREATE TABLE goals (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  target_amount INTEGER NOT NULL,
  target_date   TEXT,
  note          TEXT,
  completed_at  TEXT,
  created_at    TEXT NOT NULL,
  created_by    TEXT REFERENCES members(id)
);

-- F11.1: one or more categories, whose combined balance measures progress.
CREATE TABLE goal_categories (
  goal_id     TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  PRIMARY KEY (goal_id, category_id)
);
CREATE INDEX idx_goal_categories ON goal_categories(category_id);

`,
  },
  {
    name: "0004-assets",
    sql: `
--------------------------------------------------------------------------------
-- F19 · Assets, holdings and net worth · F20 · Multi-currency (07).
--
-- R30 is what makes this safe to have: asset accounts are Tracking accounts,
-- so their value can never reach Ready to Assign (FW1), and no table here is
-- ever read by the budget engine.
--------------------------------------------------------------------------------

-- R24.6: identified by provider symbol AND ISIN where available, so changing
-- price provider does not orphan the holding.
CREATE TABLE instruments (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL
                CHECK (kind IN ('mutual-fund','equity','etf','bond','commodity','other')),
  symbol        TEXT,
  isin          TEXT,
  currency      TEXT NOT NULL DEFAULT 'INR',
  provider      TEXT NOT NULL DEFAULT 'manual'
                CHECK (provider IN ('mfapi','alphavantage','manual')),
  -- R26.6: an instrument may be pinned to manual pricing permanently.
  manual_only   INTEGER NOT NULL DEFAULT 0,
  -- P4: refresh cadence differs by class; equities burn a scarce quota.
  refresh       TEXT NOT NULL DEFAULT 'daily'
                CHECK (refresh IN ('daily','weekly','never')),
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_instruments_isin ON instruments(isin);

CREATE TABLE holdings (
  id            TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL REFERENCES accounts(id),
  instrument_id TEXT NOT NULL REFERENCES instruments(id),
  note          TEXT,
  closed_at     TEXT,
  created_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_holdings_unique ON holdings(account_id, instrument_id)
  WHERE closed_at IS NULL;

-- R25.1: every purchase creates a lot, and lots are never merged.
CREATE TABLE lots (
  id          TEXT PRIMARY KEY,
  holding_id  TEXT NOT NULL REFERENCES holdings(id),
  trade_date  TEXT NOT NULL,
  -- Integer milliunits (1e-3), per R24.3.
  units       INTEGER NOT NULL,
  -- Integer micro-rupees (1e-6) per unit; a NAV carries five decimals.
  price       INTEGER NOT NULL,
  fees        INTEGER NOT NULL DEFAULT 0,
  -- Paise, including capitalised fees (R24.5).
  cost        INTEGER NOT NULL,
  -- R33.1: frozen at trade date and never revalued (FW8).
  fx_rate     REAL,
  -- The transaction that paid for it, so FW4's transfer is traceable.
  transaction_id TEXT REFERENCES transactions(id),
  closed_at   TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_lots_holding ON lots(holding_id, trade_date);

-- R27 · Sales, dividends and corporate actions. Kept apart from lots because
-- a realised gain is a fact about the past, not a position.
CREATE TABLE holding_events (
  id            TEXT PRIMARY KEY,
  holding_id    TEXT NOT NULL REFERENCES holdings(id),
  date          TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN
                  ('sale','dividend','dividend-reinvested','split','bonus',
                   'merger','rights','return-of-capital')),
  units         INTEGER,
  price         INTEGER,
  amount        INTEGER,
  -- R27.4: realised gains are never folded into an unlabelled "gain".
  realised_gain INTEGER,
  ratio         REAL,
  detail_json   TEXT,
  transaction_id TEXT REFERENCES transactions(id),
  created_at    TEXT NOT NULL,
  created_by    TEXT REFERENCES members(id)
);
CREATE INDEX idx_holding_events ON holding_events(holding_id, date);

-- R26.7: a price history, so portfolio value over time is real history rather
-- than today's price applied backwards.
CREATE TABLE prices (
  instrument_id TEXT NOT NULL REFERENCES instruments(id),
  -- R26.2/R26.8: the date the price was actually published, never interpolated.
  as_of         TEXT NOT NULL,
  price         INTEGER NOT NULL,
  source        TEXT NOT NULL,
  fetched_at    TEXT NOT NULL,
  PRIMARY KEY (instrument_id, as_of)
);

-- P3: every fetch is logged, which is what makes a bad number explainable
-- three months later.
CREATE TABLE price_fetches (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  instrument_id TEXT REFERENCES instruments(id),
  provider      TEXT NOT NULL,
  requested_at  TEXT NOT NULL,
  status        TEXT NOT NULL,
  detail        TEXT
);
CREATE INDEX idx_price_fetches ON price_fetches(provider, requested_at);

-- R32 · FX rates, with publication dates and full history (R32.6), because
-- historical net worth cannot be recomputed without it.
CREATE TABLE fx_rates (
  base          TEXT NOT NULL,
  quote         TEXT NOT NULL,
  as_of         TEXT NOT NULL,
  rate          REAL NOT NULL,
  source        TEXT NOT NULL,
  fetched_at    TEXT NOT NULL,
  PRIMARY KEY (base, quote, as_of)
);

-- R23.2 · A manually valued asset stores a dated history, not one mutable
-- number. Net worth over time is meaningless otherwise.
CREATE TABLE asset_valuations (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id),
  as_of       TEXT NOT NULL,
  value       INTEGER NOT NULL,
  note        TEXT,
  created_at  TEXT NOT NULL,
  created_by  TEXT REFERENCES members(id)
);
CREATE INDEX idx_asset_valuations ON asset_valuations(account_id, as_of);

-- R29.2 · A dated net worth history, snapshotted at least monthly, so the
-- trend is real rather than reconstructed from today's prices.
CREATE TABLE net_worth_snapshots (
  as_of             TEXT PRIMARY KEY,
  cash              INTEGER NOT NULL,
  investments       INTEGER NOT NULL,
  other_assets      INTEGER NOT NULL,
  credit_cards      INTEGER NOT NULL,
  loans             INTEGER NOT NULL,
  net_worth         INTEGER NOT NULL,
  -- R29.1: the staleness of its worst input, so the figure carries its caveat.
  worst_price_date  TEXT,
  created_at        TEXT NOT NULL
);
`,
  },
  {
    name: "0005-rule-reasons",
    sql: `
--------------------------------------------------------------------------------
-- N9 · A proposed rule must say what it was inferred from.
--
-- The reason was previously written only to the event log, which meant Review
-- showed "Swiggy → Eating out" with no way to see why. That presents a
-- heuristic as a fact — exactly what N9 forbids. It is stored on the rule so
-- the sentence sits next to the button that acts on it.
--------------------------------------------------------------------------------

ALTER TABLE rules ADD COLUMN because TEXT;
`,
  },
  {
    name: "0006-cas-source-refs",
    sql: `
--------------------------------------------------------------------------------
-- 09 §6.2 · A CAS restates months it has already reported, so importing one
-- must reconcile rather than duplicate.
--
-- Matching a statement row against a lot by trade date and units looks
-- sufficient and is not: R25.4 splits a lot on a partial sale, so the original
-- 500-unit purchase is a 400-unit residual by the time the next statement
-- arrives, and the row that created it no longer matches anything. The row's
-- identity has to be *recorded*, not inferred from state that legitimately
-- changes underneath it.
--------------------------------------------------------------------------------

ALTER TABLE lots ADD COLUMN source_ref TEXT;
ALTER TABLE holding_events ADD COLUMN source_ref TEXT;

CREATE INDEX idx_lots_source_ref ON lots(source_ref);
CREATE INDEX idx_holding_events_source_ref ON holding_events(source_ref);
`,
  },
  {
    name: "0007-month-close",
    sql: `
--------------------------------------------------------------------------------
-- 08 S5 · The month-close ritual, adopted at P1 by Q26.
--
-- Note what is *not* here: nothing that locks a month. R13's rollover is
-- derived arithmetic rather than a job, and R7.g keeps every past month
-- editable. A close records that a human looked at the month and took a net
-- worth snapshot; it is a statement about attention, not a state transition.
-- The figures are stored so the history reads back without recomputing four
-- years of ledger, not because they are authoritative — they are not
-- (R7.g.1).
--------------------------------------------------------------------------------

CREATE TABLE month_closes (
  month     TEXT PRIMARY KEY,
  closed_at TEXT NOT NULL,
  closed_by TEXT REFERENCES members(id),
  note      TEXT,
  income    INTEGER NOT NULL DEFAULT 0,
  spending  INTEGER NOT NULL DEFAULT 0,
  assigned  INTEGER NOT NULL DEFAULT 0
);

-- F14.2 · Every notification type is individually toggleable per member.
-- A row means "off": the useful default is on, and a member who has never
-- touched settings should get the digest.
CREATE TABLE digest_mutes (
  member_id TEXT NOT NULL REFERENCES members(id),
  kind      TEXT NOT NULL,
  muted_at  TEXT NOT NULL,
  PRIMARY KEY (member_id, kind)
);
`,
  },
  {
    name: "0008-price-fetch-log",
    sql: `
--------------------------------------------------------------------------------
-- 07 P3 · "Every fetch MUST record: instrument, provider, request time,
-- response status, **and the price returned**. This log is what makes a bad
-- number explainable three months later."
--
-- The price and its publication date were the two the table was missing, which
-- is precisely the pair that makes the log answer the question it exists for:
-- not "did the call succeed" but "where did that number come from". The class
-- is here so P4's per-class cadence can ask when it last ran.
--------------------------------------------------------------------------------

ALTER TABLE price_fetches ADD COLUMN class TEXT;
ALTER TABLE price_fetches ADD COLUMN price INTEGER;
ALTER TABLE price_fetches ADD COLUMN as_of TEXT;

CREATE INDEX idx_price_fetches_class ON price_fetches(class, requested_at);
`,
  },
  {
    name: "0009-family-loans",
    sql: `
--------------------------------------------------------------------------------
-- 10 §3.5 · F2.10, FL1-FL9 · Private lending within the family.
--
-- What is NOT in this table is the point: there is no balance column. FL2
-- makes the outstanding figure derived from dated advances and repayments,
-- which are ordinary transfers against the account below — that is the entire
-- difference between this and a Tracking account, and the reason the subtype
-- exists rather than a note in a memo field.
--
-- There is also no rate, no tenure and no schedule. FL5: these arrangements
-- are made as an agreed total ("give me back Rs 55,000"), and 06's
-- amortisation machinery has nothing to say about them.
--------------------------------------------------------------------------------

CREATE TABLE family_loans (
  id            TEXT PRIMARY KEY,
  -- The Tracking account holding the transfers. FW1 keeps it out of the budget.
  account_id    TEXT NOT NULL REFERENCES accounts(id),
  -- FL1: a name, not a member. The other side is usually not in the household.
  counterparty  TEXT NOT NULL,
  direction     TEXT NOT NULL CHECK (direction IN ('lent','borrowed')),
  -- FL5: an agreed total, never a rate.
  agreed_total  INTEGER,
  note          TEXT,
  started_at    TEXT NOT NULL,
  closed_at     TEXT,
  -- FL7: the honest end state, and the transaction that recorded it.
  written_off_at           TEXT,
  write_off_transaction_id TEXT REFERENCES transactions(id),
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_family_loans_account ON family_loans(account_id);
`,
  },
  {
    name: "0010-statement-identity",
    sql: `
--------------------------------------------------------------------------------
-- 10 §3.6 · What statement passwords are derived from.
--
-- This table exists because Indian banks do not let you choose a statement
-- password: each derives it from your name, your date of birth or your PAN,
-- and every bank picks differently. Unattended fetching (04 §3.4) is
-- impossible without holding those three values.
--
-- **It reverses PR5**, which says statement passwords are used in memory for a
-- single import and never persisted. Storing the ingredients is storing the
-- password. That reversal is deliberate, opt-in, and recorded in 10 §3.6 with
-- its cost; it is not an oversight.
--
-- Stored in the clear, consistent with 08 S9: that decision declined
-- database encryption at rest on the reasoning that the key must live where
-- the app can read it, and chose to encrypt the *backups* instead. Adding
-- bespoke field encryption here would be exactly the key-management step S9
-- rejected, for the same little benefit.
--
-- Two things this table is NOT allowed to do, enforced in code:
--   · appear in an export (F15 exports the budget; this is not budget data,
--     and an export travels)
--   · appear in the event log or any log line
--------------------------------------------------------------------------------

CREATE TABLE statement_identity (
  member_id TEXT PRIMARY KEY REFERENCES members(id),
  -- As printed on the statement: the "first four letters" rule uses this.
  name      TEXT NOT NULL,
  pan       TEXT,
  -- DDMMYYYY, the form every bank's own instructions use.
  dob       TEXT,
  updated_at TEXT NOT NULL
);
`,
  },
  {
    name: "0011-statement-identity-mobile",
    sql: `
--------------------------------------------------------------------------------
-- 10 §3.6 · SBI's account statement derives its password from the last five
-- digits of the registered mobile number plus the date of birth. That is the
-- only rule that needs a mobile, so it is added rather than assumed — and, like
-- every other field in this table, it never leaves the server (PR5.3).
--------------------------------------------------------------------------------
ALTER TABLE statement_identity ADD COLUMN mobile TEXT;
`,
  },
  {
    name: "0012-asset-allocation",
    sql: `
--------------------------------------------------------------------------------
-- 07 F19.11 · Asset allocation by class (MUST) and by geography (SHOULD).
--
-- The instrument's *kind* — 'mutual-fund', 'equity' — does not answer the
-- allocation question: a mutual fund is equity or debt or gold, and grouping
-- by kind would report a portfolio as "100% mutual-fund". So class is stored
-- separately, defaulted from kind where the kind decides it (an ETF is equity)
-- and left null where it does not (a mutual fund needs classifying). N9: an
-- unclassified holding is shown as unclassified, never guessed into a bucket.
--
-- Region carries the F20 geography split, kept orthogonal to class so an
-- international equity fund is both.
--------------------------------------------------------------------------------

ALTER TABLE instruments ADD COLUMN asset_class TEXT;
ALTER TABLE instruments ADD COLUMN region TEXT;

-- Seed the classes the kind already determines. Mutual funds and 'other' stay
-- null until the household sets them.
UPDATE instruments SET asset_class = 'equity' WHERE kind IN ('equity','etf');
UPDATE instruments SET asset_class = 'debt'   WHERE kind = 'bond';
UPDATE instruments SET asset_class = 'gold'   WHERE kind = 'commodity';
`,
  },
  {
    name: "0013-gmail-connection",
    sql: `
--------------------------------------------------------------------------------
-- 04 §3.4 · Gmail ingestion — the stored connection.
--
-- One mailbox per member ("one member's mailbox at a time"). The refresh token
-- is a secret at rest granting read access to the mailbox, held under the same
-- discipline as statement_identity: never exported (F15), never logged (R37),
-- and deleted on revocation. The scope is gmail.readonly and nothing broader;
-- message bodies are never stored — only the fields extracted into the ledger.
--
-- last_history_id / last_fetched_at let a fetch resume where it left off, so a
-- daily poll re-reads only what is new.
--------------------------------------------------------------------------------

CREATE TABLE gmail_connections (
  member_id       TEXT PRIMARY KEY REFERENCES members(id),
  email           TEXT NOT NULL,
  refresh_token   TEXT NOT NULL,
  scope           TEXT NOT NULL,
  connected_at    TEXT NOT NULL,
  last_fetched_at TEXT,
  last_history_id TEXT
);
`,
  },
  {
    name: "0014-attachments",
    sql: `
--------------------------------------------------------------------------------
-- Q10 / F4.5 · Receipt attachments on a transaction.
--
-- The bytes live here, as a BLOB, not on a parallel disk tree. On a one-box
-- homelab (Q8) that is the simplest thing that satisfies Q10's two demands at
-- once: the backup is a copy of this database, so an attachment is backed up
-- automatically and "counts toward backup size"; and it is a row, so it counts
-- toward the restore-verification control totals (R40.2) with no special
-- handling.
--
-- Server-only and never cached on the device (R35): every view is a fresh
-- fetch served with no-store. There is no offline access to a receipt.
--
-- sha256 is stored so an identical re-upload is recognised, and so a corrupted
-- restore is detectable byte-for-byte, not merely by row count.
--------------------------------------------------------------------------------

CREATE TABLE attachments (
  id             TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  filename       TEXT NOT NULL,
  mime           TEXT NOT NULL,
  size           INTEGER NOT NULL,
  sha256         TEXT NOT NULL,
  bytes          BLOB NOT NULL,
  uploaded_by    TEXT REFERENCES members(id),
  created_at     TEXT NOT NULL
);
CREATE INDEX idx_attachments_txn ON attachments(transaction_id);
`,
  },
  {
    name: "0015-loan-moratorium",
    sql: `
--------------------------------------------------------------------------------
-- 06 R16 M3/M4 · How many months a loan's moratorium runs.
--
-- The interest_model already distinguishes the two moratorium kinds (serviced
-- vs capitalised); this is the length. Zero for a loan with no moratorium,
-- which is every loan the household currently holds — the column exists so an
-- under-construction or education loan can be modelled when one is taken.
--------------------------------------------------------------------------------
ALTER TABLE loans ADD COLUMN moratorium_months INTEGER NOT NULL DEFAULT 0;
`,
  },
  {
    name: "0016-card-statements",
    sql: `
--------------------------------------------------------------------------------
-- 02 F2.3 / 06 R6 · A credit card's statement.
--
-- A card's billing cycle is not the calendar month, and the app cannot infer
-- it — the statement date and due date are entered from the statement itself,
-- with the statemented balance. Funding advice keys off the most recent one
-- rather than the month boundary: the cash to clear the *statement* must be set
-- aside by the *due date*, whatever days those fall on.
--
-- The balance is stored in paise as a positive number (what is owed). The
-- minimum due is optional — recorded when known so the app can warn if only the
-- minimum is funded, never to encourage paying just the minimum.
--------------------------------------------------------------------------------
CREATE TABLE card_statements (
  id            TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL REFERENCES accounts(id),
  statement_date TEXT NOT NULL,
  due_date      TEXT NOT NULL,
  amount        INTEGER NOT NULL,
  minimum_due   INTEGER,
  created_at    TEXT NOT NULL,
  created_by    TEXT REFERENCES members(id)
);
CREATE INDEX idx_card_statements ON card_statements(account_id, statement_date);
`,
  },
  {
    name: "0017-request-failures",
    sql: `
--------------------------------------------------------------------------------
-- B66 · Request failures, so a 500 is visible after the fact.
--
-- job_runs records what the scheduled jobs did, and the health page counted
-- failures from it — but a route that threw was recorded nowhere at all. In
-- production the request log line is debug and filtered out, and onError
-- handled the error before the server's error branch could log it, so a 500
-- produced no output and no signal on the one page you open when something is
-- wrong. This table is the record; the health page reads it alongside job_runs.
--
-- S7 applies as everywhere else: a path and a message, never a body and never a
-- financial value.
--------------------------------------------------------------------------------
CREATE TABLE request_failures (
  id        TEXT PRIMARY KEY,
  at        TEXT NOT NULL,
  method    TEXT NOT NULL,
  path      TEXT NOT NULL,
  status    INTEGER NOT NULL,
  message   TEXT,
  stack     TEXT
);
CREATE INDEX idx_request_failures ON request_failures(at);

--------------------------------------------------------------------------------
-- B67 · Two tables nothing can ever write.
--
-- autoassign_rules was the store behind the original rule-driven auto-assign.
-- That was replaced by funding straight to each category's target, and the
-- replacement reads targets. No code has inserted into this table since; it
-- was read by a loader nothing called, feeding an engine function nothing
-- reached. saved_views was never referenced by any code at all.
--
-- Both were still exported in every backup and still counted in control totals,
-- which is the cost of keeping a table that cannot hold anything.
--------------------------------------------------------------------------------
DROP TABLE IF EXISTS autoassign_rules;
DROP TABLE IF EXISTS saved_views;
`,
  },
  {
    name: "0018-month-rollups",
    sql: `
--------------------------------------------------------------------------------
-- B74 · Per-month rollups, so old history costs months rather than rows.
--
-- The budget is derived from the whole ledger, every time, which is what makes
-- R7.g possible: edit any past month and every figure since re-derives with no
-- stored total to go stale. The cost is that opening the budget scans every
-- transaction the household has ever made. Measured: 41ms at five years, 389ms
-- at twenty.
--
-- A month more than six months old is one nobody is still entering receipts
-- into, so its aggregate is computed once and kept here. Recent months are
-- still derived live on every request, and an edit to a sealed month simply
-- drops that month's rollup and it is recomputed on the next read.
--
-- The invalidation is a trigger rather than a call in the domain layer, which
-- is the whole point: there is no code path — an import, a rule, a repair
-- script, a future feature nobody has written yet — that can change a
-- transaction without the rollup for its month disappearing in the same
-- statement. A cache that code has to remember to clear is the bug this
-- codebase spends most of its effort avoiding.
--------------------------------------------------------------------------------
CREATE TABLE month_rollups (
  month       TEXT NOT NULL,
  -- Which of the engine's facts this row carries.
  fact        TEXT NOT NULL CHECK (fact IN ('categorised','account-flow','transfer-flow')),
  -- Empty string rather than NULL: SQLite treats NULLs in a primary key as
  -- distinct, which would silently allow duplicates.
  category_id TEXT NOT NULL DEFAULT '',
  account_id  TEXT NOT NULL DEFAULT '',
  kind        TEXT NOT NULL DEFAULT '',
  amount      INTEGER NOT NULL,
  PRIMARY KEY (month, fact, category_id, account_id)
) WITHOUT ROWID;

-- A month with no activity at all has no rows, which is indistinguishable from
-- a month that has not been computed. This says which months are done.
CREATE TABLE month_rollup_state (
  month    TEXT PRIMARY KEY,
  built_at TEXT NOT NULL
);

CREATE TRIGGER trg_rollup_tx_insert AFTER INSERT ON transactions
BEGIN
  DELETE FROM month_rollups      WHERE month = substr(NEW.date, 1, 7);
  DELETE FROM month_rollup_state WHERE month = substr(NEW.date, 1, 7);
END;

-- An update can move a transaction between months, so both ends are dropped.
CREATE TRIGGER trg_rollup_tx_update AFTER UPDATE ON transactions
BEGIN
  DELETE FROM month_rollups      WHERE month IN (substr(OLD.date, 1, 7), substr(NEW.date, 1, 7));
  DELETE FROM month_rollup_state WHERE month IN (substr(OLD.date, 1, 7), substr(NEW.date, 1, 7));
END;

CREATE TRIGGER trg_rollup_tx_delete AFTER DELETE ON transactions
BEGIN
  DELETE FROM month_rollups      WHERE month = substr(OLD.date, 1, 7);
  DELETE FROM month_rollup_state WHERE month = substr(OLD.date, 1, 7);
END;

-- A split carries its own category and amount, and its month comes from the
-- transaction it belongs to.
CREATE TRIGGER trg_rollup_split_insert AFTER INSERT ON transaction_splits
BEGIN
  DELETE FROM month_rollups WHERE month IN
    (SELECT substr(date, 1, 7) FROM transactions WHERE id = NEW.transaction_id);
  DELETE FROM month_rollup_state WHERE month IN
    (SELECT substr(date, 1, 7) FROM transactions WHERE id = NEW.transaction_id);
END;

CREATE TRIGGER trg_rollup_split_update AFTER UPDATE ON transaction_splits
BEGIN
  DELETE FROM month_rollups WHERE month IN
    (SELECT substr(date, 1, 7) FROM transactions WHERE id IN (OLD.transaction_id, NEW.transaction_id));
  DELETE FROM month_rollup_state WHERE month IN
    (SELECT substr(date, 1, 7) FROM transactions WHERE id IN (OLD.transaction_id, NEW.transaction_id));
END;

CREATE TRIGGER trg_rollup_split_delete AFTER DELETE ON transaction_splits
BEGIN
  DELETE FROM month_rollups WHERE month IN
    (SELECT substr(date, 1, 7) FROM transactions WHERE id = OLD.transaction_id);
  DELETE FROM month_rollup_state WHERE month IN
    (SELECT substr(date, 1, 7) FROM transactions WHERE id = OLD.transaction_id);
END;

-- An account's kind decides which bucket its every transaction falls in, and
-- its opening balance reaches RTA as income. Either changing re-colours history
-- wholesale, so the safe answer is to drop everything and rebuild.
CREATE TRIGGER trg_rollup_account_update AFTER UPDATE ON accounts
WHEN OLD.kind <> NEW.kind
  OR OLD.opening_balance <> NEW.opening_balance
  OR OLD.opening_date <> NEW.opening_date
BEGIN
  DELETE FROM month_rollups;
  DELETE FROM month_rollup_state;
END;

CREATE TRIGGER trg_rollup_account_insert AFTER INSERT ON accounts
BEGIN
  DELETE FROM month_rollups;
  DELETE FROM month_rollup_state;
END;
`,
  },
  {
    name: "0019-rollup-balances",
    sql: `
--------------------------------------------------------------------------------
-- B74 · The rollup also carries account balances now.
--
-- A balance is the sum of every transaction ever recorded against an account,
-- which was the other place a long history was paid for on every page load.
-- It reads from the same sealed months as the budget facts, so it needs a
-- fourth value in the fact column.
--
-- The table is dropped and recreated rather than altered: it holds nothing but
-- a cache of figures derived from the ledger, so throwing it away costs one
-- rebuild on the next read and is the safest way to change its shape. Doing it
-- as a new migration rather than editing the last one means a database that
-- already ran 0018 is corrected too.
--------------------------------------------------------------------------------
DROP TABLE IF EXISTS month_rollups;

CREATE TABLE month_rollups (
  month       TEXT NOT NULL,
  fact        TEXT NOT NULL
              CHECK (fact IN ('categorised','account-flow','transfer-flow','balance')),
  category_id TEXT NOT NULL DEFAULT '',
  account_id  TEXT NOT NULL DEFAULT '',
  kind        TEXT NOT NULL DEFAULT '',
  amount      INTEGER NOT NULL,
  PRIMARY KEY (month, fact, category_id, account_id, kind)
) WITHOUT ROWID;

-- Everything sealed so far predates the balance rows, so it all rebuilds.
DELETE FROM month_rollup_state;
`,
  },
  {
    name: "0020-drop-payee-default-category",
    sql: `
--------------------------------------------------------------------------------
-- B82 · payees.default_category_id, which nothing ever wrote or read.
--
-- The intent was clearly that a payee should remember where its money goes, and
-- that turned out to be answerable without storing anything: payeeStats already
-- derives the usual category from the transactions themselves, which cannot
-- drift from the ledger and needs no screen to maintain. The add form now uses
-- that.
--
-- A stored override would be a second, quieter answer to the same question, and
-- the first thing a household would notice is the two disagreeing.
--------------------------------------------------------------------------------
ALTER TABLE payees DROP COLUMN default_category_id;
`,
  },
];
