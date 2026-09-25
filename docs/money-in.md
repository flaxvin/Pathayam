# Import

Every source terminates in the same review queue. Nothing reaches the ledger
without passing through it.

```
CSV ┐
PDF ┼→ parse → duplicate check → rules → staged_transactions → approve → ledger
Gmail ┘                                                       → merge
                                                              → reject
```

## CSV

`POST /import` with a pasted or uploaded delimited file.

1. The delimiter is detected.
2. `guessMapping` proposes which column is date, narration, debit, credit,
   balance and reference, and which row is the header.
3. The mapping is confirmed on `/import/map` and may be saved as a profile.
4. A saved profile is matched on subsequent imports by header signature.

Both layouts are supported: a single signed amount column, or separate debit and
credit columns.

### Reading an amount

CSV cells, PDF figures and alert amounts are read by the same rules
(`parseAmount` in `src/core/money.ts`, in its `statement` context):

- `Dr` and `Cr` are the bank's markers, attached or spaced, any case, with or
  without a dot: `1,200.00Cr` is a ₹1,200 credit, `1200DR` a ₹1,200 debit.
- A bank never writes shorthand, so `L`, `K` and crore are not read in a file:
  `1.2L` in a CSV is an error row.
- Grouping must be Indian (`12,34,567`) or Western (`1,234,567`); `1,23` is
  refused. More than two decimal places is refused, not rounded.
- A figure that says "minus" twice — `-450 Dr`, `(450) Dr`, `(-450)` — is
  refused.
- `₹`, `Rs.`, `Rs ` and `INR` prefixes and the Unicode minus `−` are accepted.

In a form (typed), `Cr` can also mean crore. It is the credit marker on a
statement-shaped figure (grouped, or four or more rupee digits: `1200Cr`),
crore on one or two rupee digits written against it (`3Cr`, `1.25Cr`), and
refused in between (`450Cr`, `3 Cr`), because reading either way wrongly is
an error of 10^7.

### Reading a date

CSV cells, PDF rows, alerts and typed dates all end in one calendar check
(`calendarDate` in `src/core/dates.ts`):

- The day must exist in that month: `31/02/2026` and `29/02/2026` are refused,
  `29/02/2028` is read.
- The year must be between 1900 and 2199: `15-01-0026` is a typo, refused
  rather than stored two thousand years early.
- A two-digit year below 70 is this century (`26` is 2026), 70 and above the
  last (`85` is 1985).

The shapes read are the same everywhere: `15-01-2026`, `15/01/26`,
`15.01.2026`, `2026-01-15`, `2026/01/15`, `15-Jan-2026`, `15 Jan 2026`,
`15 January 26`, and any of them followed by a time (`15-01-2026 10:32`,
`28-08-26, 00:01:28 IST`), which is dropped. A two-digit year-first date
(`26-08-15`) is read as day-first unless the mapping's `dateFormat` is
`yyyy-mm-dd`.

A CSV row whose date cannot be read is an error row, never a silent skip. A
row is skipped as a footer only when its date cell says so (`Total`,
`Opening Balance`, `Page 2 of 3`), or its date cell is empty and it carries no
amount or a footer marker. A merchant named `SWIGGY*ORDER` or `TOTAL GAS` no
longer makes its row a footer.

## PDF statements

`POST /import/pdf` with a statement file. The reader is implemented in
`src/pdf/` — object parsing, RC4 and AES decryption, and text extraction that
preserves column layout.

### Password derivation

With a statement identity saved (Settings → statement identity: name, date of
birth, PAN, registered mobile), candidates are derived and tried in order. The
bank is taken from the destination account's institution, so its own rule is
tried first.

| Rule | Bank |
|---|---|
| Name + DDMM, several capitalisations | most |
| Name + DDMM + YY | RBL |
| DDMMYYYY, DDMM, YYYYMMDD | general |
| PAN, upper and lower | general |
| PAN + DDMMYYYY; first five PAN letters + DDMMYYYY | brokers |
| Last five of the mobile + DDMMYY | SBI account |
| DDMMYYYY + last four of the card | SBI Card |
| Last four of the card alone | Canara |
| DDMMYY + last six of the card | HSBC |

The interface reports which candidate opened the file, described rather than
quoted. The password itself is never stored or logged.

When no candidate works and the bank's rule needs a detail the household has not
saved, the message names that detail.

### Bank layouts

Eleven banks are recognised by signature: HDFC, ICICI, Axis, SBI, Union Bank,
Canara, YES, IndusInd, Kotak, RBL, HSBC. A twelfth profile covers broker
contract notes.

Each profile carries its signatures, a password hint, and a skip list of lines
that are never transactions.

### Reading rows

Amounts are derived from **balance movement**: the difference between
consecutive running balances is the amount, sign included. The printed amount
verifies that movement. Where the two disagree, the row is reported as an error
rather than guessed.

Where a statement prints no balance column, amounts are read by column position
against the table header.

Two layout cases are handled explicitly, each as a second attempt made only
after the ordinary read yields nothing:

- **Figures drawn in pieces.** Some generators emit one number as several text
  runs, leaving single spaces inside dates and amounts. The date, figure and
  header readers each have a tolerant pattern that matches across those spaces
  and reports the span in the original line, preserving every column offset.
- **A summary column beside the table.** Where the page places another block to
  the left of the transactions, the table's own Date heading marks its left edge
  and lines are sliced there.

Lines matching opening balance, brought forward or carried forward are never
transactions.

### Reconciliation

Where a statement prints both an opening and a closing balance, the parse is
checked against them: `opening + Σ amounts − closing` must be zero. The result is
exposed on `StatementParse.reconciliation` and reported after import.

### Unreadable files

A PDF with no extractable text is refused with an explanation — it is a scan.
A PDF whose table cannot be parsed falls through to the manual column mapping
screen, the same one an unrecognised CSV uses.

## Gmail

Opt-in, separate from sign-in, scope `gmail.readonly`. Granted from Settings and
revocable there.

`STATEMENT_SENDERS` maps sender addresses to banks; only recognised senders are
read. Attachments are passed to the PDF path; alert bodies to the email-alert
parser. The refresh token is stored in `gmail_connections` and excluded from
every export.

## Duplicate detection

Every staged row is compared against existing transactions **in the same
account** and against rows already pending in that account.

| Tier | Test | Handling |
|---|---|---|
| `exact` | Same `source_id`. | Skipped. Re-importing a file adds nothing. |
| `strong` | Same date, amount and narration. | Merged automatically, with a note. |
| `probable` | Close on date and amount. | Queued for a decision. |
| `weak` | Weaker match. | Queued for a decision. |
| `manual-vs-imported` | A typed transaction matching an imported one. | Queued for a decision. |

`source_id` is `adapter:sha256(date, amount, narration, reference):occurrence`.
Because it names its adapter, the exact tier compares it alone; approval keeps
the batch's own source (`pdf`, `email`, …) on the transaction. A row that is
somehow already in the ledger when approved is resolved onto that transaction
rather than added twice.
The occurrence counter distinguishes genuinely identical rows within one file.
Uniqueness is enforced per account.

## Rules

A rule has a stage, conditions, and actions.

- **Stages:** `pre`, `default`, `post`. Rules run in that order, so a broad rule
  can be overridden by a later specific one.
- **Condition fields:** `narration`, `channel`, `vpa`, `merchant`, `reference`,
  `importedPayee`, `payee`, `account`, `amount`, `absoluteAmount`, `direction`,
  `date`, `dayOfMonth`, `memo`, `tags`, `category`.
- **Operators:** `is`, `isNot`, `contains`, `doesNotContain`, `startsWith`,
  `endsWith`, `matches`, `oneOf`, `notOneOf`, `greaterThan`, `lessThan`,
  `between`. Text comparison is case-insensitive.
- **Actions:** `setCategory`, `setPayee`, `setMemo` (set, prepend or append),
  `addTag`, `removeTag`, `setOwner`, `setCleared`, `setAccount`, `setDate`,
  `splitFixed`, plus flags to mark for review or ignore.
- **Match mode:** all conditions, or any.

A rule can be tested against existing transactions before saving, and applied
retroactively after.

### Narration extraction

`extractNarrationFields` derives `channel` (UPI, NEFT, IMPS, …), `vpa`,
`reference` (the longest digit run of six or more) and `merchant` from raw
narration. The merchant is the longest remaining segment after removing the
rail, the reference, and known noise tokens; a trailing reference, bracketed or
bare, is stripped.

## Learning

Filing the same payee into the same envelope repeatedly proposes a rule. The
proposal records the evidence count in `rules.strength` and states it in
`rules.because`.

Proposals are never applied. They are listed strongest first, the leading few
shown and the remainder behind a count, on both `/review` and `/rules`.
Confirming clears `proposed`. Dismissing sets `dismissed_at` and records a
suppression so the same suggestion is not made again.

## Undoing an import

An entire batch can be undone from `/import`, which removes the transactions it
created and marks the batch `undone_at`.

Importing the same file again after an undo stages its rows afresh, and they
can be approved: the undone transactions give up their `source_id` (it is
kept with a `~deleted:<id>` suffix) so the new ones can take it.
