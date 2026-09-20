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
  /**
   * Set when the migration rebuilds a table other tables point at.
   *
   * SQLite's own recipe for rebuilding a table requires `foreign_keys` to be
   * OFF, and the pragma is a no-op inside a transaction — so the runner has to
   * turn it off around the whole thing. `DROP TABLE` on a parent increments the
   * deferred-violation counter for every child row, and re-parenting the rows
   * by renaming the replacement back into place does not decrement it: the
   * COMMIT fails with a violation that `PRAGMA foreign_key_check` cannot find.
   *
   * The runner still runs `foreign_key_check` before committing, so a rebuild
   * that genuinely orphans a row is still refused.
   */
  rebuildsTable?: true;
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
-- I5, per account: the same statement line can genuinely occur on two accounts,
-- and the pipeline's own duplicate check is scoped to one. See migration 0037.
CREATE UNIQUE INDEX idx_tx_source_id ON transactions(account_id, source, source_id)
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
  {
    name: "0021-rollup-credit-unfiled",
    sql: `
--------------------------------------------------------------------------------
-- B97 · A fifth fact: card charges nobody has filed yet.
--
-- The payment envelope holds money a category gave up in order to meet a card's
-- debt. An unreviewed charge gave nothing up, so it must not raise the envelope
-- — and while it did, the accounting identity was out by the amount of every
-- card transaction sitting in the review queue.
--
-- Dropped and recreated rather than altered, as in 0019: the table is a cache
-- of figures derived from the ledger, so throwing it away costs one rebuild.
--------------------------------------------------------------------------------
DROP TABLE IF EXISTS month_rollups;

CREATE TABLE month_rollups (
  month       TEXT NOT NULL,
  fact        TEXT NOT NULL
              CHECK (fact IN ('categorised','account-flow','transfer-flow','balance','credit-unfiled')),
  category_id TEXT NOT NULL DEFAULT '',
  account_id  TEXT NOT NULL DEFAULT '',
  kind        TEXT NOT NULL DEFAULT '',
  amount      INTEGER NOT NULL,
  PRIMARY KEY (month, fact, category_id, account_id, kind)
) WITHOUT ROWID;

DELETE FROM month_rollup_state;
`,
  },
  {
    name: "0022-account-holder",
    sql: `
--------------------------------------------------------------------------------
-- H2 · Whose account is this
--------------------------------------------------------------------------------
-- Every account still funds the one shared budget — that is 02 §3 and it does
-- not move. This records *whose* account it is, which a household with two
-- current accounts and four cards knows perfectly well and previously could not
-- tell the app.
--
-- Deliberately nullable and deliberately inert: nothing in the engine reads it.
-- An account with a holder and an account without one behave identically, so a
-- household that does not care never has to fill it in.
ALTER TABLE accounts ADD COLUMN holder_member_id TEXT REFERENCES members(id);
`,
  },
  {
    name: "0023-account-visibility",
    sql: `
--------------------------------------------------------------------------------
-- H2.2 · Private accounts
--------------------------------------------------------------------------------
-- Only a Tracking account may be private, and the reason is arithmetic rather
-- than policy. Ready to Assign is a sum over every Budget account, so hiding one
-- while showing the total publishes it anyway: subtract the visible balances
-- from Ready to Assign plus what is assigned, and the hidden figure falls out.
-- Tracking accounts fund nothing (FW1) and appear in no shared total the engine
-- computes, so they can be hidden without lying about it.
--
-- The CHECK enforces that. It is not a convention someone can quietly break in
-- a later migration.
ALTER TABLE accounts ADD COLUMN visibility TEXT NOT NULL DEFAULT 'household'
  CHECK (visibility IN ('household','private'));
`,
  },
  {
    name: "0024-budgets",
    sql: `
--------------------------------------------------------------------------------
-- 15 · Budgets — the unit that owns money
--------------------------------------------------------------------------------
-- A budget is what an account's money belongs to and what an envelope lives in.
-- Exactly one household budget, and at most one personal budget per member.
--
-- This migration deliberately changes no behaviour. Every existing account and
-- every existing envelope lands in the household budget, so a household that
-- never touches the feature keeps precisely the app it had. The riskiest part
-- of 15 is this backfill, and it is done first while nothing depends on it.
CREATE TABLE budgets (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('household','personal')),
  -- Null for the household budget; the owner for a personal one.
  member_id  TEXT REFERENCES members(id),
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK ((kind = 'household') = (member_id IS NULL))
);

-- SQLite treats NULLs as distinct in a UNIQUE constraint, so "exactly one
-- household" and "one personal each" both need partial indexes rather than a
-- table constraint.
CREATE UNIQUE INDEX idx_budgets_one_household ON budgets(kind) WHERE kind = 'household';
CREATE UNIQUE INDEX idx_budgets_member ON budgets(member_id) WHERE member_id IS NOT NULL;

-- Tracking accounts stay null: FW1 keeps them out of every budget, which is why
-- loans and assets need no change at all.
ALTER TABLE accounts        ADD COLUMN budget_id TEXT REFERENCES budgets(id);
ALTER TABLE category_groups ADD COLUMN budget_id TEXT REFERENCES budgets(id);
ALTER TABLE categories      ADD COLUMN budget_id TEXT REFERENCES budgets(id);

INSERT INTO budgets (id, kind, member_id, name, created_at)
VALUES ('budget-household', 'household', NULL, 'Household', datetime('now'));

UPDATE accounts        SET budget_id = 'budget-household' WHERE kind IN ('budget','credit');
UPDATE category_groups SET budget_id = 'budget-household';
UPDATE categories      SET budget_id = 'budget-household';

CREATE INDEX idx_accounts_budget   ON accounts(budget_id);
CREATE INDEX idx_categories_budget ON categories(budget_id);
`,
  },
  {
    name: "0025-budget-scoped-state",
    sql: `
--------------------------------------------------------------------------------
-- 15 · The remaining per-budget state
--------------------------------------------------------------------------------
-- Held money and a closed month belong to one budget, not to the household in
-- general. Both backfill to the household budget, so nothing changes today.
ALTER TABLE held_for_next_month ADD COLUMN budget_id TEXT REFERENCES budgets(id);
ALTER TABLE month_closes        ADD COLUMN budget_id TEXT REFERENCES budgets(id);

UPDATE held_for_next_month SET budget_id = 'budget-household';
UPDATE month_closes        SET budget_id = 'budget-household';

-- The rollup now records which account a transfer leg moved, so a sealed month
-- can be read back for one budget. Existing rows predate that column being
-- populated, so the cache is emptied and rebuilt rather than left half-right.
DELETE FROM month_rollups;
DELETE FROM month_rollup_state;
`,
  },
  {
    name: "0026-private-personal-accounts",
    rebuildsTable: true,
    sql: `
--------------------------------------------------------------------------------
-- H2.2a · Privacy follows the budget
--------------------------------------------------------------------------------
-- 0023 forbade a private Budget or Credit account, and was right while every
-- account sat in the one household budget: Ready to Assign summed it, so hiding
-- it published it by subtraction.
--
-- With personal budgets that stops being true. The household budget never sums a
-- personal account — it sums only what its owner has committed (15 §3.3) — so a
-- private account in a personal budget publishes nothing. SQLite cannot alter a
-- CHECK in place, so the table is rebuilt.
--
-- Rebuilding a table half the schema points at needs one more thing: with
-- foreign_keys ON, DROP TABLE accounts is an implicit DELETE of every row, and
-- every transaction, card and reconciliation referencing one of them raises a
-- violation. PRAGMA foreign_keys cannot be changed inside a transaction and
-- every migration runs in one, so defer the checking instead — by COMMIT the
-- table is back under its own name with all its rows, and the check passes.
-- Found the way it should be: this migration failed on a real database with
-- data in it while passing on every empty one in the test suite. The runner
-- turns foreign_keys off around a migration marked rebuildsTable, and checks
-- for real orphans before it commits.
CREATE TABLE accounts_new (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  nickname         TEXT,
  kind             TEXT NOT NULL CHECK (kind IN ('budget','credit','tracking')),
  subtype          TEXT NOT NULL,
  institution      TEXT,
  last4            TEXT,
  currency         TEXT NOT NULL DEFAULT 'INR',
  opening_balance  INTEGER NOT NULL DEFAULT 0,
  opening_date     TEXT NOT NULL,
  statement_day    INTEGER,
  due_day          INTEGER,
  credit_limit     INTEGER,
  sort             INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  created_by       TEXT,
  closed_at        TEXT,
  holder_member_id TEXT REFERENCES members(id),
  budget_id        TEXT REFERENCES budgets(id),
  visibility       TEXT NOT NULL DEFAULT 'household'
                   CHECK (visibility IN ('household','private')),
  -- The rule, restated: private is allowed for a Tracking account, or for one
  -- whose budget is somebody's own. Never for an account in the household
  -- budget, where the household's own Ready to Assign would give it away.
  CHECK (
    visibility = 'household'
    OR kind = 'tracking'
    OR (budget_id IS NOT NULL AND budget_id <> 'budget-household')
  )
);

INSERT INTO accounts_new
  SELECT id, name, nickname, kind, subtype, institution, last4, currency,
         opening_balance, opening_date, statement_day, due_day, credit_limit,
         sort, created_at, created_by, closed_at, holder_member_id, budget_id,
         visibility
    FROM accounts;

DROP TABLE accounts;
ALTER TABLE accounts_new RENAME TO accounts;

CREATE INDEX idx_accounts_budget ON accounts(budget_id);

-- DROP TABLE takes the table's triggers with it, and 0018's rollup
-- invalidation lives on this one. Without these two the cache would go stale
-- the moment an account was added or its kind changed, which is precisely the
-- disagreement B74's test exists to catch — and did.
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
    name: "0027-household-commitment-envelope",
    sql: `
--------------------------------------------------------------------------------
-- 15 §3 · Committing money to the household without moving any
--------------------------------------------------------------------------------
-- An envelope in a personal budget whose purpose is the household's budget.
-- Assigning to it commits that money; no cash leaves the account holding it,
-- which is what lets a private account fund shared spending without publishing
-- its balance (15 §3.3).
--
-- The claim the household sees is the sum of these envelopes' balances. It is
-- derived, never stored, so there is no second ledger to keep in step — the
-- same reasoning that makes a card's payment envelope trustworthy (R6).
ALTER TABLE categories ADD COLUMN commits_to_budget_id TEXT REFERENCES budgets(id);

-- One envelope per pair of budgets. Two envelopes both committing to the
-- household would double-count the claim, and nothing downstream could tell.
CREATE UNIQUE INDEX idx_categories_commitment
  ON categories(budget_id, commits_to_budget_id)
  WHERE commits_to_budget_id IS NOT NULL;

-- A commitment is money the other budget is counting on, so a change to one
-- invalidates the cached months of both. The rollup cache is all-or-nothing, so
-- clearing it is the whole of the invalidation.
CREATE TRIGGER trg_rollup_commitment_insert AFTER INSERT ON categories
WHEN NEW.commits_to_budget_id IS NOT NULL
BEGIN
  DELETE FROM month_rollups;
  DELETE FROM month_rollup_state;
END;
`,
  },
  {
    name: "0028-every-envelope-has-a-budget",
    sql: `
--------------------------------------------------------------------------------
-- 15 · An envelope with no budget belongs to nobody, and is read by nobody
--------------------------------------------------------------------------------
-- 0024 put every existing row in the household budget, and four creators were
-- never told to do the same: a card's payment envelope, a loan's, the
-- Reconciliation envelope, and the blank-start group. Anything they made
-- afterwards had budget_id NULL, and every scoped read compares with "=", which
-- NULL never satisfies — so those envelopes and their assignments vanished from
-- the household's grid and from its identity, which failed by exactly their
-- balance.
--
-- The creators now set it. This puts right what they left behind: a payment
-- envelope joins its account's budget, a loan's joins the account that repays
-- it, and anything else joins the household's.
UPDATE categories
   SET budget_id = COALESCE(
     (SELECT a.budget_id FROM accounts a WHERE a.id = categories.payment_account_id),
     (SELECT a.budget_id FROM loans l
        LEFT JOIN accounts a ON a.id = l.repayment_account_id
       WHERE l.payment_category_id = categories.id),
     'budget-household'
   )
 WHERE budget_id IS NULL;

UPDATE category_groups
   SET budget_id = COALESCE(
     (SELECT c.budget_id FROM categories c
       WHERE c.group_id = category_groups.id AND c.budget_id IS NOT NULL
       LIMIT 1),
     'budget-household'
   )
 WHERE budget_id IS NULL;

-- A tracking account funds no budget (FW1), so a NULL there is correct and is
-- deliberately left alone. Every other account belongs somewhere.
UPDATE accounts
   SET budget_id = 'budget-household'
 WHERE budget_id IS NULL AND kind <> 'tracking';
`,
  },
  {
    name: "0029-rebuild-rollup-for-cross-budget-transfers",
    sql: `
--------------------------------------------------------------------------------
-- 15 §3.5 · "Internal to the budget" now means what it says
--------------------------------------------------------------------------------
-- A transfer leg was excluded from Ready to Assign whenever its other leg was a
-- Budget or Credit account, on the reasoning that the money never left the
-- budget. With one budget that was true. With two it was not: ₹5,000 moved from
-- a personal account to the joint one, and ₹8,400 paid toward a household card,
-- both left the payer's budget while being treated as though they had not.
--
-- The rule is now checked rather than assumed, so every cached month computed
-- under the old one is wrong. The rollup is a summary of the ledger and can
-- always be rebuilt from it, so it is simply emptied; the next read builds what
-- it needs.
DELETE FROM month_rollups;
DELETE FROM month_rollup_state;
`,
  },
  {
    name: "0030-calling-it-even",
    sql: `
--------------------------------------------------------------------------------
-- 15 §4A · When one of you has put in more
--------------------------------------------------------------------------------
-- A balance between two budgets can end three ways, and only one of them is
-- letting something go. The first two need nothing stored — putting it down to
-- yourself is an ordinary move out of Ready to Assign, and picking it up is an
-- ordinary commitment. This table is the third.
--
-- 15 §4A.4 · What is given up is an expense for the one giving it and income for
-- the one receiving it, which is the rule writeOffFamilyLoan already encodes.
-- So each row means two things at once: the giving budget spends that amount from
-- the category named here, and the receiving budget's commitment envelope falls
-- by the same amount against income of the same amount. Both sets of books close
-- and neither gains a figure with no history behind it.
CREATE TABLE even_calls (
  id                 TEXT PRIMARY KEY,
  -- The month it is counted in, so it lands where the conversation happened.
  month              TEXT NOT NULL,
  -- The commitment envelope whose balance is being closed, and the direction is
  -- read from its sign: positive means the envelope's budget was behind.
  envelope_id        TEXT NOT NULL REFERENCES categories(id),
  -- The budget letting it go, and the envelope the expense lands in.
  giving_budget_id   TEXT NOT NULL REFERENCES budgets(id),
  giving_category_id TEXT NOT NULL REFERENCES categories(id),
  -- Always positive. Partial amounts are ordinary (15 §4A.5).
  amount             INTEGER NOT NULL CHECK (amount > 0),
  note               TEXT,
  created_at         TEXT NOT NULL,
  created_by         TEXT REFERENCES members(id)
);
CREATE INDEX idx_even_calls_month ON even_calls(month);
CREATE INDEX idx_even_calls_envelope ON even_calls(envelope_id);

-- It changes what two budgets' months say, so every cached month goes.
CREATE TRIGGER trg_rollup_even_call_insert AFTER INSERT ON even_calls
BEGIN
  DELETE FROM month_rollups;
  DELETE FROM month_rollup_state;
END;
CREATE TRIGGER trg_rollup_even_call_delete AFTER DELETE ON even_calls
BEGIN
  DELETE FROM month_rollups;
  DELETE FROM month_rollup_state;
END;
`,
  },
  {
    name: "0031-month-close-per-budget",
    rebuildsTable: true,
    sql: `
--------------------------------------------------------------------------------
-- 15 §6.1 · Each budget closes on its own
--------------------------------------------------------------------------------
-- The household month can close while a personal one is still open, and the
-- other way round. Coupling them would let one person's procrastination block
-- the other's ritual, which is the opposite of what the ritual is for.
--
-- So a close is identified by month *and* budget. Every close made until now was
-- a household one, because it was the only budget there was.
CREATE TABLE month_closes_new (
  month      TEXT NOT NULL,
  budget_id  TEXT NOT NULL REFERENCES budgets(id),
  closed_at  TEXT NOT NULL,
  closed_by  TEXT REFERENCES members(id),
  note       TEXT,
  income     INTEGER NOT NULL DEFAULT 0,
  spending   INTEGER NOT NULL DEFAULT 0,
  assigned   INTEGER NOT NULL DEFAULT 0,
  -- 15 §3 · What each member had committed when the month was closed, as JSON.
  -- A record of what was true then, not a figure anything derives from: the live
  -- numbers always come from the envelopes.
  commitments TEXT,
  PRIMARY KEY (month, budget_id)
);

INSERT INTO month_closes_new (month, budget_id, closed_at, closed_by, note, income, spending, assigned)
  SELECT month, 'budget-household', closed_at, closed_by, note, income, spending, assigned
    FROM month_closes;

DROP TABLE month_closes;
ALTER TABLE month_closes_new RENAME TO month_closes;
`,
  },
  {
    name: "0032-goals-belong-to-a-budget",
    sql: `
--------------------------------------------------------------------------------
-- 15 §6B · A goal is personal or shared, chosen once
--------------------------------------------------------------------------------
-- A goal is measured by its categories' balances (F11), so moving it between
-- budgets would move the meaning of money underneath a figure people have been
-- watching for months: the trip fund that was yours becomes the household's, and
-- the history stops describing the same thing. Creating a new goal in the other
-- budget and closing this one is honest about what happened; silently
-- re-pointing it is not.
--
-- So there is no edit path for this column, only a choice at creation. Every
-- goal that exists today was the household's, because the household's was the
-- only budget there was.
ALTER TABLE goals ADD COLUMN budget_id TEXT REFERENCES budgets(id);
UPDATE goals SET budget_id = 'budget-household' WHERE budget_id IS NULL;
CREATE INDEX idx_goals_budget ON goals(budget_id);
`,
  },
  {
    name: "0033-card-emi-conversion",
    sql: `
--------------------------------------------------------------------------------
-- 06 §7.4 · Converting a card purchase to EMI
--------------------------------------------------------------------------------
-- A card EMI is an ordinary loan with one thing worth recording that no other
-- loan has: which card the purchase was made on. An EMI converted on an add-on
-- belongs to the primary account and its instalments appear on that account's
-- statement, so the card matters for attribution even though the liability does
-- not move (09 §4, R6.c).
ALTER TABLE loans ADD COLUMN card_id TEXT REFERENCES cards(id);

-- And the charge that was converted, so the conversion can be traced back to the
-- purchase it came from rather than being an unexplained credit on the card.
ALTER TABLE loans ADD COLUMN converted_from_transaction_id TEXT REFERENCES transactions(id);
`,
  },
  {
    name: "0034-rescue-accounts-private-to-nobody",
    sql: `
--------------------------------------------------------------------------------
-- H2.2 · A thing private to nobody is a thing nobody can find
--------------------------------------------------------------------------------
-- "Private" filters on the holder: visible when holder_member_id matches the
-- viewer. With no holder it matches no member, so a private account with no
-- holder is invisible to every single person — including whoever set it, which
-- makes it unfixable through the app, because undoing it would require seeing it.
-- Everything hanging off such an account goes with it: its transactions, its
-- balance, and any schedule that pays from it.
--
-- The combination is refused now, in both directions. This rescues rows that
-- reached it before the guard existed, and the only recoverable choice is to make
-- them shared: the app cannot guess whose they were meant to be, and leaving them
-- hidden leaves money nobody can reach. A household that wanted one private can
-- set it again, this time saying whose.
UPDATE accounts
   SET visibility = 'household'
 WHERE visibility = 'private' AND holder_member_id IS NULL;
`,
  },
  {
    name: "0035-loans-remember-their-original-tenure",
    sql: `
--------------------------------------------------------------------------------
-- R19.1 / R20.2 · The tenure moves, so the original has to be kept
--------------------------------------------------------------------------------
-- Two of the choices a borrower actually gets to make change the tenure: a
-- prepayment applied by shortening the term, and a rate reset taken by keeping
-- the instalment. Until now neither was applied at all, because tenure_months
-- was the only tenure the loan had and it doubled as the baseline every lifetime
-- figure is measured against. Shortening it would have silently erased the very
-- saving the household had just bought: "instalments saved" is the projection
-- against the baseline, and moving both together always reads zero.
--
-- So the original is recorded once, here, and never moves again. tenure_months
-- becomes the live tenure, free to shorten or extend as the loan is actually
-- repaid, and R22's lifetime metrics keep comparing against the loan as it was
-- first scheduled -- which is the only comparison that means anything.
ALTER TABLE loans ADD COLUMN original_tenure_months INTEGER;
UPDATE loans SET original_tenure_months = tenure_months;
`,
  },
  {
    name: "0036-a-proposal-remembers-its-evidence",
    sql: `
--------------------------------------------------------------------------------
-- N9 · How many times the app saw the pattern it is proposing
--------------------------------------------------------------------------------
-- A proposal already states its evidence in words — "You've put Zomato in Going
-- out 4 times" — and three years of filing produces forty-three of them, shown
-- as one flat list in the order they happened to be written. Every one is
-- individually reasonable and collectively they are a wall: the eye stops at
-- four, and the proposal seen thirty-six times sits below the one seen three.
--
-- The count was in the sentence and nowhere a query could reach. Here it is, so
-- the strongest can lead and the rest can wait behind a number.
ALTER TABLE rules ADD COLUMN strength INTEGER;
`,
  },
  {
    name: "0037-one-line-can-happen-on-two-accounts",
    sql: `
--------------------------------------------------------------------------------
-- I5 · A row's identity belongs to its account
--------------------------------------------------------------------------------
-- A statement line's source id is a hash of date, amount, narration and
-- reference. Two accounts can produce the same four: "UPI/SWIGGY/4471" for
-- 450.00 on the 5th of August is one payment from the joint account and another
-- from a personal one, and a household with two accounts at the same bank hits
-- this the first time it imports both.
--
-- The pipeline already knew that. Its duplicate check is scoped to the account
-- being imported into, so it staged both rows — correctly — and then the
-- database refused the second with UNIQUE constraint failed, as a 500 with a SQL
-- message in it, leaving the row stuck in the queue with no way to approve it.
--
-- Two layers disagreeing about what makes a row unique. The pipeline was right:
-- the index is now scoped the same way it is.
DROP INDEX IF EXISTS idx_tx_source_id;
CREATE UNIQUE INDEX idx_tx_source_id ON transactions(account_id, source, source_id)
  WHERE source_id IS NOT NULL;
`,
  },
  {
    name: "0038-a-way-in-that-is-not-google",
    sql: `
--------------------------------------------------------------------------------
-- F1.6 · A household may sign in without an account somewhere else
--------------------------------------------------------------------------------
-- GOOGLE_CLIENT_ID was documented as configuration and was in practice
-- mandatory: /auth/google was the only door that opens in production, so
-- running this app on your own machine still meant registering a project with
-- a company and routing every sign-in through it. For an application whose
-- whole claim is that the data stays on your server, that was the one
-- dependency that contradicted it.
--
-- A password lives in its own table rather than a column on members, for two
-- reasons. It keeps the secret out of every query that reads a member — the
-- member row is selected on nearly every request, and a hash that is never
-- loaded cannot be logged, serialised into a view model or exported by
-- accident. And it makes "has no password" the absence of a row, so a
-- household using OIDC or Google never carries an empty credential.
CREATE TABLE member_passwords (
  member_id     TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
  hash          TEXT NOT NULL,
  -- Set when an administrator assigns a password rather than the member
  -- choosing it, so the app can insist it is changed at first use.
  must_change   INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT NOT NULL,
  -- Lockout is per credential, not per address: an attacker on a fresh IP each
  -- time must still not get unlimited guesses at one person's password.
  failed_count  INTEGER NOT NULL DEFAULT 0,
  locked_until  TEXT
);
`,
  },
  {
    name: "0039-what-the-tax-estimate-was-told",
    sql: `
--------------------------------------------------------------------------------
-- Q31 · The figures behind a tax estimate
--------------------------------------------------------------------------------
-- Document 02, N15 said this app must never compute a tax liability or a
-- deduction. That is deliberately reversed; the reasoning is in the decisions
-- log. What
-- the reversal does not change is that the estimate is arithmetic on numbers a
-- person supplies, so those numbers have to be stored somewhere they can be
-- corrected and kept year to year.
--
-- Per member and per financial year, because income tax in India is assessed
-- on an individual. A household figure would be meaningless, and worse, it
-- would mix one member's salary into another's estimate — exactly the kind of
-- leak the budget screens are careful about.
--
-- Amounts are paise, like everything else. Gross is stored rather than derived
-- because the ledger can only see money that arrived in accounts this app
-- holds, which is not the same as taxable income and never will be.
CREATE TABLE tax_declarations (
  member_id     TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  fy            INTEGER NOT NULL,
  gross         INTEGER NOT NULL DEFAULT 0,
  s80c          INTEGER NOT NULL DEFAULT 0,
  s80d          INTEGER NOT NULL DEFAULT 0,
  s80d_senior   INTEGER NOT NULL DEFAULT 0,
  other         INTEGER NOT NULL DEFAULT 0,
  hra_received  INTEGER NOT NULL DEFAULT 0,
  hra_rent_paid INTEGER NOT NULL DEFAULT 0,
  hra_basic     INTEGER NOT NULL DEFAULT 0,
  hra_metro     INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (member_id, fy)
);
`,
  },
  {
    name: "0040-a-schedule-can-split-the-way-a-transaction-does",
    sql: `
--------------------------------------------------------------------------------
-- F7 · A recurring payment that lands in more than one envelope
--------------------------------------------------------------------------------
-- A schedule posted to exactly one category, which is wrong for the two most
-- regular things a household has. A salary arrives and is immediately three
-- things: what went to provident fund, what was deducted as tax, and what
-- actually landed. Rent is often rent plus maintenance plus parking, one
-- payment on one date every month.
--
-- Both had to be entered by hand every month and then split by hand, which is
-- precisely the work a schedule exists to remove.
--
-- The lines mirror transaction_splits rather than inventing a second shape,
-- because when the schedule posts, these become that.
CREATE TABLE schedule_splits (
  id          TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  category_id TEXT REFERENCES categories(id),
  amount      INTEGER NOT NULL,
  memo        TEXT,
  sort        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_schedule_splits ON schedule_splits(schedule_id);
`,
  },
  {
    name: "0041-the-first-sunday-of-each-month",
    sql: `
--------------------------------------------------------------------------------
-- F7.3 · A schedule that falls on a weekday rather than a date
--------------------------------------------------------------------------------
-- Some commitments are not "the 5th" — they are "the first Sunday", "the last
-- Friday". The domestic help paid on the first Sunday; the standing order that
-- runs on the last working day.
--
-- 'monthly-nth-weekday' has been in the Recurrence union and in the
-- annualisation table behind the subscriptions view since P1, but
-- nextOccurrence() never had a case for it: it fell through to the default and
-- advanced by day of month. A schedule set that way would have behaved as
-- ordinary monthly and said nothing. It was unreachable from the UI, which is
-- the only reason it never bit anyone.
--
-- The ordinal and the weekday are stored rather than inferred from next_due,
-- because inference cannot tell "the 8th" from "the second Sunday" once the
-- date has moved on, and the two diverge the following month.
--
-- Ordinals stop at the fourth, with -1 for "last". A fifth weekday exists in
-- some months and not others, so offering it would mean a schedule that
-- silently skips four months a year, or a policy for what to do instead —
-- which is not a question anybody wants to answer about their rent.
ALTER TABLE schedules ADD COLUMN recurrence_ordinal INTEGER;
ALTER TABLE schedules ADD COLUMN recurrence_weekday INTEGER;
`,
  },
];
