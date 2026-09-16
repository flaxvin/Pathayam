# Getting money in

Typing every transaction is how a budget dies. This is the machinery that stops
you having to — built for Indian banking, which means UPI narrations, split
credit-card cycles, and statement PDFs locked with a password derived from your
own name.

Everything arrives in the same place: a **review queue**. Nothing reaches the
ledger without passing through it.

```
  CSV  ─┐
  PDF  ─┼─▶  parse  ─▶  duplicate check  ─▶  rules  ─▶  review queue  ─▶  ledger
 Gmail ─┘                                                     ▲
                                                        you approve,
                                                     merge, or reject
```

## CSV

Upload a file, and the app guesses which column is which — date, narration,
debit, credit, balance, reference. Confirm the guess once and it is saved as a
**profile** for that account, recognised by its header signature every month
after.

Indian banks split debit and credit into two columns far more often than they
sign one, and both shapes are handled.

## Statement PDFs

The PDF reader is written here — object parsing, RC4 and AES decryption, and
text extraction that preserves layout, because a statement is a table and a
table that loses its columns is unparseable.

### Passwords

Most Indian bank statements are encrypted with something derived from your own
details. Save your name, date of birth, PAN and registered mobile once
(Settings), and the app derives the candidates and tries them:

| | |
|---|---|
| Name + DDMM | the most common family, in several capitalisations |
| DOB as DDMMYYYY, DDMMYY, YYYYMMDD | on its own |
| PAN, alone and with the DOB | several brokers use the first five PAN letters |
| Last five of the mobile + DOB | SBI account statements |
| DOB + last four of the card | SBI Card |
| Last four alone | Canara |
| DOB + last six of the card | HSBC |

The app says which one worked — *"it opened with your PAN"* — and never stores
or logs the password itself.

When none work it names **which detail is missing** rather than shrugging.
Measured against a real corpus of seventy-seven statements from twelve
institutions, every single file that could not be opened was missing one of two
things: the registered mobile, or the card's last four. Both are one field.

### Reading the table

Eleven bank layouts are recognised by signature. Two problems in real statements
are worth knowing about, because both look like the parser is broken when it is
not:

**Figures drawn in pieces.** Some generators emit one number as several text
runs — `27,333.00` as `2`, `7,3`, `33.0`, `0` — and the layout pass puts each at
its own column, so the line reads `2 7,3 33.0 0` and the date reads
`2 7-03 -202 6`. Every date and amount stops matching and the statement parses
to nothing while looking perfectly healthy. The date, figure and header readers
each have a second, tolerant pattern, tried **only where the strict one already
failed**, and each reports the span it matched in the original line — spaces
included — so no column offset shifts.

**A summary beside the table.** One bank prints the account summary down the
left of the page and the transactions down the right, sharing lines. A table
announces its left edge with its own Date heading, so the parser slices there —
again, only as a second attempt, after the ordinary read comes back empty.

### The balance column checks the work

Every Indian statement prints a running balance, and the movement between two
rows *is* the amount, sign included. The parser derives amounts from that
movement and uses the printed figure to verify it, rather than the other way
round. Where the two disagree the row is reported instead of guessed.

The statement's own closing balance then checks the whole parse. On the real
corpus, twelve statements print one and all twelve reconcile to the paise. That
is an oracle nothing else in this app gets for free, and it has vetoed three
plausible-looking parser changes that were quietly wrong.

## Gmail

Opt-in, separate from signing in, and `gmail.readonly`. The app looks only at
senders it recognises as statement or alert addresses, and the grant can be
revoked from Settings. Tokens are excluded from every export.

## Duplicates

The same transaction arrives twice — you typed it, then the statement listed it;
or a file was imported again. Five tiers, and only the top one decides alone:

| | |
|---|---|
| **exact** | Same source id. Skipped silently: re-importing a file adds nothing. |
| **strong** | Same date, amount and narration. Merged with a note. |
| **probable** | Close on date and amount. Asked about. |
| **weak** | Might be. Asked about. |
| **manual-vs-imported** | You typed it, the bank confirmed it. Asked about. |

A row's identity is a hash of its date, amount, narration and reference —
**scoped to the account**. Two accounts can genuinely produce the same four
values (the same shop, the same amount, the same day, on the joint card and the
personal one), and treating those as one row is wrong.

## Rules

A rule matches on narration, merchant, VPA, channel, reference, payee, account,
amount, direction, date, day of month, memo, tags or category, and sets a payee,
a category, a memo, tags, or flags the row for review. Rules run in three
stages — `pre`, `default`, `post` — so a broad rule can be overridden by a
specific one.

Rules can be tried against your own history before being saved, and applied
retroactively to transactions already filed.

## Learning

File the same payee into the same envelope a few times and the app proposes a
rule, stating its evidence:

> You've put Blinkist in Books and courses 36 times.

Proposals are **proposed**, never applied. Three years of use produces dozens,
so they are ranked by that evidence and the strongest handful shown, with the
rest behind a count — a proposal seen thirty-six times and one seen three should
not be the same size on the screen.

Dismissing one suppresses that specific suggestion permanently. Saying no is
heard once and remembered.

## What is not automated

- **No bank API connections.** India has no usable open-banking surface for a
  self-hosted app, and screen-scraping a bank login is not something this will
  do with somebody's real credentials.
- **No SMS parsing.** It needs a phone-side agent; the alert emails carry the
  same information.
