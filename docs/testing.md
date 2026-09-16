# How it is checked

1,119 tests across 92 files, run with `node:test`. No framework, no mocking
library, no fixtures directory.

```bash
npm test
npm test -- --test-name-pattern="identity"
node --experimental-strip-types --test src/engine/engine.test.ts
```

## Three oracles

Most tests assert what somebody expected. Three things here can say *wrong*
without anybody having decided what right looked like, and they have caught more
real defects than every hand-written expectation combined.

### 1. The accounting identity

```
Σ budget-account balances  +  due from other budgets
    =  Σ category balances  +  Ready to Assign  +  held for next month
       +  Σ future assignments  −  unfunded credit absorbed
```

`identityResidual(state)` must be exactly zero, in integer paise. It is asserted
after **every month, in every budget**, as a three-year history is built — not
once at the end, so a break names the month it started in.

Found: a family-loan write-off that put a categorised transaction on a tracking
account; a loan instalment that never consumed its payment envelope, so
households were paying for EMIs twice in budget terms.

### 2. The rollup cache versus the ledger

Every month is computed twice — once from the cached aggregates, once from the
raw ledger — and the two must agree. A stale cache is otherwise silent: every
screen reads the cache, so a wrong one is simply believed.

### 3. The bank's own closing balance

Real statements print a running balance and a closing figure the parser did not
derive. It either matches or it does not.

This is the sharpest tool in the box, and it has **vetoed three plausible parser
changes**. One of them looked like a clear win — more rows read, statements that
had never parsed suddenly parsing — and the reconciliation said it was reading
the running balance as the movement. Another improved payee names dramatically
and quietly lost a real ₹2,246 interest credit while merging two transactions
into one.

## The top-down simulation

`src/sim/scenario.ts` is a household of four using the app for thirty-six
months: salaries, rent, groceries, cards, quarterly statement imports with real
duplicates, loans taken and prepaid and closed, a portfolio with dividends and a
merger and a split, goals met, months closed and reopened, tags, splits, rules
proposed and confirmed and applied.

At month 24 two members leave. At month 30 one returns. That shape is deliberate
— removing a member is where the arithmetic is hardest and where nothing else
looks.

The same simulation seeds the demo, so the demo is not a separate fiction that
can rot.

`scenario.test.ts` asks the questions:

- the identity holds after every month in every budget;
- the cache agrees with the ledger everywhere;
- **every mutating function** in `src/domain/` and `src/import/` is called —
  read out of the source, not from a list somebody maintains, so a new domain
  mutation that nothing simulates fails on the day it is written;
- removing a member is a state and not a deletion: their name stays on
  everything they entered, and adding them back finds them again;
- and it all holds on a second seed the app has never seen.

### Counting what it produced

Calling every function is not the same as exercising a feature. A census of what
three years of simulation *left behind* found three tables empty —
`rule_applications`, `transaction_splits`, and all but one tag — while every
test passed and the coverage check was satisfied.

Rules were proposed forty-three times and confirmed zero times, because
confirming lived in a route handler where no simulation could reach it. The
census is now part of the suite: rules must actually file something, splits must
exist and sum to their transaction, more than one tag must be in use.

## The guards

Tests that enforce a rule about the code rather than a behaviour of it.

| | |
|---|---|
| `privacy-sweep.test.ts` | Every screen rendered as the wrong member, checked for planted strings. |
| `viewer-required.test.ts` | Every function that accepts a viewer is passed one, or is listed with a reason. |
| `privacy-by-id.test.ts` | Every parameterised route aimed at somebody else's private thing answers not-found. |
| `redirect-safety.test.ts` | No redirect target reaches a response without being filtered. |
| `cross-site-writes.test.ts` | A write from another origin is refused and changes nothing. |
| `api-docs.test.ts` | Every route is documented and every documented path exists. |
| `link-coverage.test.ts` | Every route is reachable by a link from somewhere. |
| `mobile-reachability.test.ts` | Everything the sidebar offers is reachable on a phone. |
| `concurrent-writers.test.ts` | Two members editing the same month at once lose nothing. |
| template guards | No backtick inside a template literal's own comments — a parse error that truncates silently in one file and has bitten four times. |

## The UI audit

Not in the suite — it needs a browser — but run as part of any top-down pass:
every screen at two widths in both themes, checked for contrast against what
text actually sits on, tap-target size, labels, duplicate ids, heading order and
overflow. Driven over CDP with no dependencies.

## What is not covered

- **Gmail ingestion.** It needs a live OAuth grant, so it cannot run in a test
  at all. The parser has fixtures; the fetch loop does not.
- **PDF import against real statements.** Exercised by hand against a corpus of
  seventy-seven real files from twelve institutions, which cannot be committed.
  The automated coverage is generated fixtures, and a synthetic statement
  reproducing the piece-splitting layout that broke three real ones.
