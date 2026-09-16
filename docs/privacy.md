# Privacy inside a household

A household budget is shared. Not everything in a household is.

The promise, in the words the app itself uses: **nobody sees anybody else's
accounts, balances or other envelopes.** This document is what that means
mechanically, and how it is kept true.

## Budgets

The household has one budget. Each member may also have a **personal budget**,
with its own accounts, its own envelopes and its own Ready to Assign.

A member sees the household's budget and their own. That is the whole rule:
`budgetsFor(db, memberId)` returns those two, and everything else follows.

## Accounts

An account is `shared` or `private`, and a private account has a holder. The
predicate is one line, and it is the same line everywhere:

```sql
(visibility <> 'private' OR holder_member_id IS ?)
```

Private accounts stay out of lists, pickers, reports, exports, the activity log,
insights, payee lists, and — the one most easily forgotten — **totals**. A net
worth figure that includes what you cannot see publishes it by subtraction: the
Overview once showed one member ₹55.6L while the page behind it showed her
₹28.6L, and the difference was exactly the private money.

Loans and family arrangements carry the same flag, with the same consequence.

## Not-found, never "not allowed"

Asking for something you may not see gets **404**, not 403. A refusal confirms
the thing exists, and for a private account the existence *is* the disclosure.

## The three guards

Fourteen separate leaks have been found in this app. Each was fixed, and each
time the more useful question was *what kind of blindness let it through* —
because the answer was never the same twice, and a guard for one kind is
structurally incapable of seeing the others.

There are now three, and they are deliberately different shapes.

### 1. `privacy-sweep.test.ts` — every screen, as the wrong person

Plants a distinctive string in each kind of private thing — an account, an
envelope, a payee, a loan, a family arrangement — renders **every GET route the
router serves** as the member who cannot see them, and fails on any match. The
screen list comes from the route table, so a screen added tomorrow is swept
tomorrow.

Found five leaks on its first run, including the activity log (which narrates
everything in words, with an undo button beside each) and insights on the front
page ("Qwertyuiop Envelope is new this month").

**Blind to:** a leaked *number*, which has no string to search for. And any route
that addresses one thing, because it has no id to give it.

### 2. `viewer-required.test.ts` — every call names who is looking

Reads every function in `src/` that accepts a `viewerMemberId` out of the
source, then requires that **every call in `app.ts` passes one**, or that the
call is listed with a written reason. Both halves are read from the code, so a
function that gains a viewer tomorrow is enforced tomorrow.

Found the Overview's net-worth headline, and a charge-category picker on a
parameterised route.

**Blind to:** a function that never took a viewer at all. `getBytes(db, id)` had
nothing missing.

### 3. `privacy-by-id.test.ts` — every route, aimed at somebody else's thing

Builds one member's private everything, then aims **every parameterised route**
at it as a different member and requires not-found.

Found eighteen. Five read — an account's whole register, a transaction, and the
**bytes of the receipt attached to it**, byte for byte, with its filename in the
header. Thirteen wrote: close the account, recategorise the transaction, delete
it, delete the receipt, hide and delete the envelope, delete the group.

## How a route stays honest

Routes do not fetch by id and render. They resolve through a guard that returns
only what the viewer may see:

| | |
|---|---|
| `requireVisibleAccount` | the account, or not-found |
| `requireVisibleTransaction` | the transaction — checking both its account **and** its envelope |
| `requireVisibleCategory` | the envelope |
| `requireVisibleGroup` | the group, via its budget |
| `requireVisibleAttachment` | the receipt, via its transaction |

The write side matters as much as the read side. A form field is a suggestion:
posting an id by hand once filed a household transaction into another member's
private envelope, and confirmed the envelope existed by succeeding.

## Impersonation

An admin-debug mode can view the app as another member, read-only by default,
with a banner on every page. Writes have to be enabled explicitly, and the
theme preference is still stored against the real member — a display preference
belongs to the viewer, not to the person being viewed.

## Commitments between budgets

A member can commit money from their own budget to the household's. That claim
appears in the identity as `due from other budgets`, so the arithmetic still
closes across budgets without either side seeing the other's accounts.

The words matter here and were chosen carefully: an envelope with too little in
it is **underfunded**, not *in debt*. Between two people running a household,
the language of default is the wrong register.
