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

-- R9: the machine-executable form of a target. Configured through a form with
-- a plain-language preview (Q9) — params_json is never typed by a user in P0.
CREATE TABLE autoassign_rules (
  category_id TEXT PRIMARY KEY REFERENCES categories(id),
  type        TEXT NOT NULL CHECK (type IN (
                'fixed','fixed-ceiling','refill','refill-hold','rate-limited',
                'periodic','by-date','percent-income','average-history',
                'copy','remainder-sweep')),
  params_json TEXT NOT NULL,
  -- Band 1 is highest. Remainder sweeps always run last regardless of band.
  priority    INTEGER NOT NULL DEFAULT 5,
  enabled     INTEGER NOT NULL DEFAULT 1,
  updated_at  TEXT NOT NULL
);

--------------------------------------------------------------------------------
-- Payees (F5)
--------------------------------------------------------------------------------

CREATE TABLE payees (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
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
];
