# Pathayam — documentation

What the app is, how it is built, and how to run it. Written against the code as
it stands rather than as it was designed, and re-derived whenever the two drift
apart.

| | |
|---|---|
| [architecture.md](architecture.md) | The shape of the thing: layers, the engine, storage, why there are no dependencies. |
| [budgeting.md](budgeting.md) | The envelope model — Ready to Assign, rollover, overspend, credit cards, targets, closing a month. |
| [money-in.md](money-in.md) | Getting transactions in: CSV, statement PDFs, Gmail, the review queue, duplicates, rules. |
| [privacy.md](privacy.md) | Per-member privacy — what a household shares, what it does not, and the three guards that hold the line. |
| [security.md](security.md) | The security posture, what has been checked, and what is deliberately not defended against. |
| [operations.md](operations.md) | Running it: deployment, configuration, backups, updates, health. |
| [testing.md](testing.md) | How it is checked — unit tests, the thirty-six-month simulation, and the three oracles that can say "wrong". |
| [decisions.md](decisions.md) | The decisions that still bind, and why. |
| [API.md](API.md) | The HTTP surface and personal API tokens. Under test: a route this file omits fails the build. |
| [dev/01-engine-derivation.md](dev/01-engine-derivation.md) | The accounting identity, derived. Referenced from the engine source by section. |

## The archive

[`archive/`](archive/) holds the original design documents — twenty numbered
files written before and during the build, plus the scripts that verify their
arithmetic.

They are kept for a specific reason, not sentiment. **The source code cites them
by requirement id**: `R6` for the credit-card rules, `F3.6` for a layout
constraint, `B124` for a fixed defect, `H2.2` for the privacy promise. Three
hundred and twenty-three distinct ids appear in comments across `src/`, and each
one resolves to a numbered document in there. Renumbering them would orphan
every reference, so they keep their numbers and their text.

Read the archive to find out **why** something is the way it is. Read the
documents above to find out **what it does now**. Where the two disagree, the
code is right and this set is wrong — please say so.

Three of the archived documents are still worth reading on their own:

- [`09-decisions-log.md`](archive/09-decisions-log.md) — every decision taken
  during the build, with its reasoning, in order.
- [`18-second-top-down.md`](archive/18-second-top-down.md) — a full pass over the
  app with fresh data, including five attempts at one defect and why four of
  them were thrown away.
- [`19-security-review.md`](archive/19-security-review.md) — the review that
  found twenty-two defects, and the list of everything checked that was sound.

Their verifiers still run:

```bash
python3 docs/archive/verify_docs.py
```
