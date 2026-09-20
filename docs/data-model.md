# Data model

68 tables. Money columns are integer paise; dates are `YYYY-MM-DD`; months are
`YYYY-MM`; timestamps are IST strings.

## Household and people

| Table | Key columns | Notes |
|---|---|---|
| `household` | `id`, `name`, `base_currency`, `overspend_model`, `auto_assign_on_rollover`, `first_day_of_week`, `fiscal_year_start_month`, `card_due_warning_days`, `setup_completed_at` | Single row, `id = 1`. |
| `members` | `id`, `email`, `name`, `google_sub`, `theme`, `allowed`, `removed_at` | `removed_at` marks departure; rows are never deleted. |
| `budgets` | `id`, `kind`, `member_id`, `name` | `kind` is `household` or `personal`. A personal budget names its member. |
| `sessions` | `id`, `member_id`, `expires_at`, `revoked_at`, `impersonating_member_id`, `impersonation_writes`, `impersonation_expires_at` | Token stored as a SHA-256 hash in `id`. |
| `api_tokens` | `id`, `member_id`, `name`, `token_hash`, `scope`, `expires_at`, `revoked_at`, `last_used_at` | `scope` is `read` or `read-write`. |
| `auth_attempts` | `source`, `at`, `outcome`, `detail` | Drives sign-in rate limiting. |
| `statement_identity` | `member_id`, `name`, `pan`, `dob`, `mobile` | Used only to derive statement passwords. Excluded from every export. |
| `gmail_connections` | `member_id`, `email`, `refresh_token`, `scope`, `last_history_id` | Excluded from every export. |

## Accounts and money

| Table | Key columns | Notes |
|---|---|---|
| `accounts` | `id`, `name`, `nickname`, `kind`, `subtype`, `institution`, `last4`, `currency`, `opening_balance`, `opening_date`, `statement_day`, `due_day`, `credit_limit`, `closed_at`, `holder_member_id`, `budget_id`, `visibility` | `kind` ∈ `budget`, `credit`, `tracking`. `visibility` ∈ `shared`, `private`. |
| `cards` | `id`, `account_id`, `label`, `last4`, `is_primary`, `holder_member_id`, `closed_at` | Physical cards on one credit account, including add-ons. |
| `card_statements` | `id`, `account_id`, `statement_date`, `due_date`, `amount`, `minimum_due` | |
| `transactions` | `id`, `account_id`, `card_id`, `date`, `amount`, `payee_id`, `category_id`, `is_split`, `memo`, `cleared`, `owner_member_id`, `transfer_pair_id`, `reimbursable`, `source`, `import_batch_id`, `source_id`, `raw_*`, `deleted_at` | Negative is outflow. Deletion is soft. |
| `transaction_splits` | `id`, `transaction_id`, `category_id`, `amount`, `memo`, `sort` | Must sum to the transaction amount. |
| `transaction_tags`, `tags` | `tag_id`, `name`, `budget_amount`, `starts_on`, `ends_on` | Tags may carry their own budget over a period. |
| `payees`, `payee_aliases` | `id`, `name`, `default_account_id`, `merged_into_id`; `payee_id`, `raw` | Merging sets `merged_into_id`. |
| `attachments` | `id`, `transaction_id`, `filename`, `mime`, `size`, `sha256`, `bytes` | Blob storage. Images and PDF only, 10 MB cap. |
| `reconciliations` | `id`, `account_id`, `as_of`, `bank_balance`, `app_balance`, `adjustment_transaction_id`, `broken_at`, `broken_reason` | A checkpoint breaks when a transaction before `as_of` changes. |

A unique index on `transactions(account_id, source, source_id)` where
`source_id` is not null makes re-importing a file idempotent per account.

## Budgeting

| Table | Key columns | Notes |
|---|---|---|
| `category_groups` | `id`, `name`, `kind`, `sort`, `hidden_at`, `budget_id` | `kind` distinguishes normal groups from app-managed ones. |
| `categories` | `id`, `group_id`, `name`, `sort`, `hidden_at`, `deleted_at`, `payment_account_id`, `budget_id`, `commits_to_budget_id` | `payment_account_id` marks a credit-card payment envelope. `commits_to_budget_id` marks a commitment envelope. |
| `assignments` | `month`, `category_id`, `amount` | Primary key `(month, category_id)`. Absolute, not deltas. |
| `targets` | `category_id`, `type`, `amount`, `target_date`, `period`, `schedule_id` | `type` ∈ `monthly`, `refill`, `by-date`, `debt-payoff`, `spending`. |
| `held_for_next_month` | `month`, `amount`, `budget_id` | Money withheld from a month's Ready to Assign. |
| `goals`, `goal_categories` | `id`, `name`, `target_amount`, `target_date`, `completed_at`, `budget_id` | A goal owns one or more envelopes. |
| `month_closes` | `month`, `budget_id`, `closed_at`, `closed_by`, `note`, `income`, `spending`, `assigned`, `commitments` | Per budget, not per household. |
| `even_calls` | `id`, `month`, `envelope_id`, `giving_budget_id`, `giving_category_id`, `amount` | Settling a lopsided month between budgets. |
| `month_rollups`, `month_rollup_state` | `month`, `fact`, `category_id`, `account_id`, `kind`, `amount`; `month`, `built_at` | Aggregate cache, invalidated by trigger. |

## Import

| Table | Key columns | Notes |
|---|---|---|
| `import_batches` | `id`, `source`, `adapter`, `account_id`, `file_name`, `rows_read`, `created_count`, `duplicate_count`, `auto_approved_count`, `error_count`, `errors_json`, `undone_at` | A batch can be undone as a unit. |
| `staged_transactions` | `id`, `batch_id`, `account_id`, `row_number`, `date`, `amount`, `raw_*`, `source_id`, `proposed_payee`, `category_id`, `applied_rules_json`, `duplicate_of_id`, `duplicate_tier`, `duplicate_reason`, `status`, `transaction_id` | `status` ∈ `pending`, `approved`, `merged`, `rejected`. |
| `import_profiles` | `id`, `name`, `account_id`, `header_signature`, `mapping_json`, `last_used_at` | Column mapping recognised by header signature. |
| `rules` | `id`, `name`, `stage`, `conditions_json`, `actions_json`, `enabled`, `proposed`, `dismissed_at`, `times_applied`, `because`, `strength` | `proposed = 1` is a suggestion awaiting confirmation. |
| `rule_applications` | `transaction_id`, `rule_id`, `at` | |
| `review_dismissals` | `kind`, `ref`, `at`, `member_id` | Permanent suppression of one suggestion. |

## Loans

| Table | Key columns | Notes |
|---|---|---|
| `loans` | `id`, `account_id`, `lender`, `loan_type`, `sanctioned`, `sanction_date`, `interest_model`, `benchmark`, `tenure_months`, `original_tenure_months`, `first_instalment_date`, `instalment_day`, `repayment_account_id`, `payment_category_id`, `moratorium_months`, `card_id`, `converted_from_transaction_id`, `closed_at` | |
| `loan_rates` | `id`, `loan_id`, `effective_from`, `annual_rate_pct` | Rate history; the schedule is recomputed from it. |
| `loan_payments` | `id`, `loan_id`, `date`, `amount`, `principal`, `interest`, `estimated`, `kind`, `transaction_id` | `kind` distinguishes instalments from prepayments. |
| `loan_disbursements` | `id`, `loan_id`, `date`, `amount`, `destination`, `destination_account_id` | For tranche-drawn loans. |
| `loan_statements` | `id`, `loan_id`, `as_of`, `lender_outstanding`, `interest_paid_ytd`, `instalments_remaining`, `app_outstanding`, `resolved` | Records drift between the lender's figure and the app's. |
| `family_loans` | `id`, `account_id`, `counterparty`, `direction`, `agreed_total`, `written_off_at`, `write_off_transaction_id`, `closed_at` | Balance is derived from transactions, not stored. |

## Assets

| Table | Key columns | Notes |
|---|---|---|
| `instruments` | `id`, `name`, `kind`, `symbol`, `isin`, `currency`, `provider`, `manual_only`, `asset_class`, `region` | `kind` ∈ `mutual-fund`, `equity`, `etf`, `bond`, `commodity`, `other`. |
| `holdings` | `id`, `account_id`, `instrument_id`, `closed_at` | One instrument in one account. |
| `lots` | `id`, `holding_id`, `trade_date`, `units`, `price`, `fees`, `cost`, `fx_rate`, `transaction_id`, `closed_at` | FIFO lots. |
| `holding_events` | `id`, `holding_id`, `date`, `kind`, `units`, `price`, `amount`, `realised_gain`, `ratio`, `detail_json` | Purchases, sales, dividends, splits, mergers, returns of capital. |
| `prices`, `price_fetches` | `instrument_id`, `as_of`, `price`, `source`; fetch outcomes | |
| `fx_rates` | `base`, `quote`, `as_of`, `rate`, `source` | |
| `asset_valuations` | `id`, `account_id`, `as_of`, `value`, `note` | Hand-valued accounts. Dated history, not a mutable number. |
| `net_worth_snapshots` | `as_of`, `cash`, `investments`, `other_assets`, `credit_cards`, `loans`, `net_worth`, `worst_price_date` | |

## Scheduling and operations

| Table | Key columns | Notes |
|---|---|---|
| `schedules` | `id`, `name`, `account_id`, `payee_id`, `category_id`, `amount`, `amount_is_estimate`, `recurrence`, `next_due`, `short_month_policy`, `recurrence_ordinal`, `recurrence_weekday`, `auto_post`, `is_subscription`, `detected`, `confidence`, `enabled` | Outgoing schedules require a category. `recurrence_ordinal` (1–4, or −1 for last) and `recurrence_weekday` (0 = Sunday) apply to `monthly-nth-weekday` and are null for every other recurrence. |
| `events` | `seq`, `id`, `at`, `actor_member_id`, `real_member_id`, `source`, `entity`, `entity_id`, `action`, `before_json`, `after_json`, `summary`, `idempotency_key`, `undo_of_event_id`, `undone_by_event_id` | Append-only. |
| `idempotency_keys` | `key`, `member_id`, `request_hash`, `status`, `status_code`, `response_json` | |
| `job_runs` | `id`, `job`, `started_at`, `finished_at`, `status`, `detail` | Backup and verification runs. |
| `request_failures` | `id`, `at`, `method`, `path`, `status`, `message`, `stack` | Surfaced on the health page. |
| `digest_mutes` | `member_id`, `kind`, `muted_at` | |
| `settings_kv` | `key`, `value` | Miscellaneous per-deployment state. |
