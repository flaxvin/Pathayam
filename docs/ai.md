# Connecting an AI

Claude, ChatGPT, Gemini and any other client of the
[Model Context Protocol](https://modelcontextprotocol.io) can read the budget
and answer questions from it, and, where the operator and the member both allow
it, file and annotate transactions and suggest the rest. The app is its own MCP server, at
`<BASE_URL>/mcp`. There is no separate process, and nothing is sent anywhere
until a member connects an app.

- [What a connection can do](#what-a-connection-can-do)
- [Connecting](#connecting)
- [Tools](#tools)
- [Changes an AI can make](#changes-an-ai-can-make)
- [Masking](#masking)
- [What they have read](#what-they-have-read)
- [The analysis summary](#the-analysis-summary)
- [Protocol](#protocol)
- [Code](#code)

Switched off with `FEATURE_AI=false` ([operations.md](operations.md)): the
endpoint, the sign-in, the page and `/export/analysis.json` are then 404s. The hosted Solo plan runs
that way.

## What a connection can do

| | |
|---|---|
| **Reads** | Always. With `AI_WRITE` off (the default) that is all: no change tool is offered, and every connection's token is read-scope. |
| **Changes** | Only where `AI_WRITE` is `standard` or `full` *and* the member ticked "allow changes" for this connection: a short list of tools, every change logged and undoable ([below](#changes-an-ai-can-make)). |
| **Sees** | What the member who connected it sees: the household budget and their own personal budget. Another member's private accounts, loans, policies and envelopes are never listed, counted or totalled ([privacy.md](privacy.md)). An id it may not see is "not found", the same as one that does not exist. |
| **Cannot reach** | Anything a token cannot reach ([API.md](API.md#what-a-token-can-never-reach)): sign-in, tokens, the member list, impersonation, OAuth approval, and the Connect an AI page itself. |
| **Leaves** | A line per question, and per change, in the access log. The answers are not kept. A change is in the activity log too. |

Whatever a tool returns is sent to that AI's provider and becomes part of the
conversation there. The Connect an AI page says so before anything is set up.

## Connecting

**Settings → API tokens → Connect an AI** (`/tokens/ai`).

| Client | How |
|---|---|
| claude.ai and the Claude apps | Settings → Connectors → add a custom connector with `<BASE_URL>/mcp`. Claude sends the member to Pathayam to sign in and approve. |
| ChatGPT | Add a connector (developer mode) with the same address; approve in Pathayam. |
| Gemini app | Settings → Connected apps → Add a custom app, where Google offers custom apps (at the time of writing, personal accounts in the US). |
| Gemini CLI | `gemini mcp add --transport http pathayam <BASE_URL>/mcp` signs in the same way, or use a token (below). |
| Claude Code, Claude Desktop, scripts | Create a connection on the page. It shows a ready `claude mcp add …` command, a `gemini mcp add …` command and a JSON configuration, each with the token in it, once. |

Signing in from the app is OAuth 2.1 with PKCE ([API.md](API.md#connecting-an-ai-app-oauth),
[security.md](security.md)). The consent page names the app and where it sends
the member back to. An app connected this way holds an access token that lasts
an hour and renews itself; a token made on the page expires after 30, 90 or
365 days. Either is ended from the page with **Disconnect**.

## Tools

Money is rupees as decimal numbers, dates are `YYYY-MM-DD` in IST, and a
financial year is named by its first year (`2026` is FY 2026-27).

| Tool | Answers |
|---|---|
| `overview` | Ready to Assign, overspent envelopes, card payments no envelope funds, account totals, net worth, the next 14 days. Start here. |
| `accounts` | Every visible account, balance, cleared and uncleared. |
| `transactions` | Filtered by date, account, envelope, payee, text and amount; newest first; 100 a page by default, 500 at most, with `next_cursor`. |
| `budget_month` | Every envelope for a month: assigned, activity, available, target. |
| `spending` | Totals between two dates by envelope, payee, month or account. |
| `loans`, `loan_schedule` | Outstanding, rate, EMI, tenure; one loan's instalments. |
| `portfolio`, `realised_gains` | Holdings, value, gain, XIRR, allocation; gains by financial year. |
| `net_worth` | The statement and its history. |
| `tax_estimate` | Both regimes for a financial year, as on the Tax screen. A year without rates is refused. |
| `cashflow` | Schedules, card dues and maturities in the coming days (30 by default). |
| `insurance`, `goals`, `financial_independence` | The registers and estimates behind those screens. |
| `explain` | How Ready to Assign, or one envelope's available amount, was reached. |
| `snapshot` | Everything above in summary, without the transaction list. |

Each tool calls the same query a screen does (`src/ai/analysis.ts`,
`src/web/screen-data.ts`), so a figure an AI quotes is the figure on the page.
A tool's answer is cut at 256 KB with a note saying so; the tools that can
return many rows page instead.

## Changes an AI can make

Three locks, all of which must be open:

1. **The deployment.** `AI_WRITE` is `off` unless the operator sets
   `standard` or `full` ([operations.md](operations.md#letting-an-ai-make-changes)).
   No plan preset sets it.
2. **The connection.** The member ticks "allow changes" when connecting: on the
   consent page an app sends them to (the `budget:write` scope), or on Connect
   an AI for a token. It is never ticked for them. Connect an AI shows which
   connections can change things.
3. **The tool.** Only the ones below exist, and a connection that may not write
   is not even shown them in `tools/list`.

| Tool | `standard` | `full` | What it does |
|---|---|---|---|
| `set_envelope` | direct | direct | Files one transaction under one envelope, a split folded into it. |
| `split_transaction` | direct | direct | Splits one into 2–25 envelope lines that add up to its amount exactly. |
| `set_memo` | direct | direct | Sets or clears a transaction's memo. |
| `set_payee_default` | direct | direct | Proposes a payee's usual envelope as a rule waiting in Review → Proposed rules. It files nothing until the member confirms it (a payee has no stored default since B82; the rule is it). Needs `FEATURE_RULES`. |
| `add_transaction` | suggestion | direct | Records money in or out of one account, uncleared. Money out needs an envelope. |
| `assign_to_envelope` | suggestion | direct | Sets what one envelope has assigned for a month. |
| `transfer` | suggestion | direct | Records money moved between two of the member's accounts. |
| Anything else | never | never | No deletes of anything, and nothing on loans, investments or assets, month closes, settings, members, tokens, imports, rules or schedules. The instructions given to the model say so. |

Every tool calls the domain function its page calls, after the same checks the
route makes, so every refusal a person would meet the model meets too, worded
for it to correct. A connection can touch only what its member can see: another
member's private account, envelope, transaction or payee is "not found".

**Suggestions** (`standard`): nothing changes. The model must give a `why`; the
suggestion waits in Review under **Suggested by your AI**, after the books' own
corrections and beside Proposed rules, with **Approve** and **Reject**. It is
tried and rolled back when it is made, so one the budget would refuse is refused
to the model at once. Only the member whose connection made it sees or decides
it, even when it only touches the household budget, because the reason comes
from that member's own conversation and can mention their private budget. Approving
makes the change as that member, checked again against what they can see then;
if it is refused, it stays waiting with the reason. The tool answers with the
suggestion id and "waiting for approval in Review".

**Attribution.** Each change is an event with source `ai`, attributed to the
member, naming the connection ("Claude Code"; "Claude (connector), suggestion
approved" for an approved suggestion). Activity has an **AI changes** filter
(`/activity?source=ai`). A direct change answers with what changed and its event
id. Arguments are in the access log like every question; masking still applies
to answers.

**Caps.** At most 100 changes and suggestions per connection per IST day, and
at most 50 suggestions waiting per connection. Past either the tool answers
`isError` with a sentence saying so, and nothing is changed.

**Undo.** Everything one connection changed today shares one idempotency key
(`ai:<connection>:<date>`; the connection is the OAuth grant, so an app's hourly
token refresh does not split it). Connect an AI offers **Undo this AI's changes
today** per connection; Activity undoes them one by one. Undo keeps its rules:

- It works for 30 days (Activity), like every undo; "today" means the IST day.
- When somebody has changed one of those records since, the undo lists those
  later changes first and asks again. **Undo anyway** puts each record back
  exactly as it was before the AI touched it, so the later changes are lost
  too. To keep them, undo the AI's changes one at a time in Activity instead.
- An AI's own later change to the same record is not "a later change": the
  group is undone newest first.
- Approved suggestions are not in the group: a member decided them. Undo them
  in Activity.

## Masking

On by default for a new connection, chosen per connection. Before an answer
leaves, in every string except the app's own ids and dates:

- digit runs of nine or more (account, card and phone numbers, UPI
  references) keep their last four digits;
- UPI IDs and email addresses keep only what follows the `@`;
- PAN numbers are masked whole.

Amounts, envelope names and payee names are what the analysis needs, so they
are sent. Masking is best effort: a pattern cannot recognise a person's name
written into a narration.

## What they have read

The page lists each connection's questions, newest first: when, which app,
which tool, its arguments, and the size of the answer, that it was refused, or
that it changed or suggested something.
A member sees only their own connections'. Rows are kept for 90 days, at most
2,000 a member (`ai_access_log`, migration 0071), except that today's changes are kept for the
daily cap. Reads are not in the activity
log, which is the budget's history; connecting and disconnecting an app are.

## The analysis summary

`GET /export/analysis.json` (Health → Data, or the link on the page) is the
`snapshot` tool as a download: a year of budget and spending by envelope,
accounts, loans, portfolio, net worth, cashflow and the tax estimate, for
pasting into any chat or opening in a spreadsheet tool without connecting
anything. `?months=` takes 1 to 36. See [API.md](API.md#get-exportanalysisjson).

## Protocol

Streamable HTTP, one `POST` per message, JSON responses, no sessions.

- **2026-07-28**: per-request `_meta`; `MCP-Protocol-Version`, `Mcp-Method`
  and `Mcp-Name` must match the body (`-32020` otherwise); `server/discover`;
  unknown methods are `404` with `-32601`.
- **2024-11-05 to 2025-11-25**: the `initialize` handshake. No
  `Mcp-Session-Id` is issued; a request without a version header is taken as
  2025-03-26.
- `GET` and `DELETE` are `405`. Notifications are `202`.
- An `Origin`, when sent, must be `BASE_URL`'s or listed in
  `MCP_ALLOWED_ORIGINS` (comma-separated); connectors call from their servers
  and send none.
- No token is a `401` with `WWW-Authenticate: Bearer resource_metadata=…`,
  which is what starts an app's sign-in.
- Tool argument errors and the domain's refusals are tool results with
  `isError: true`, worded for the model to correct.

## Code

| File | |
|---|---|
| `src/ai/mcp.ts` | The protocol: both eras, argument checks, the size cap. |
| `src/ai/tools.ts` | The tool list and the instructions given to the model. |
| `src/ai/writes.ts` | The change tools, suggestions, caps and the idempotency key. |
| `src/ai/analysis.ts` | The reads, one per tool. |
| `src/ai/redact.ts` | Masking. |
| `src/ai/access-log.ts` | The access log. |
| `src/auth/oauth.ts` | Signing in from an AI app. |
| `src/web/pages/ai.ts` | The Connect an AI page. |
