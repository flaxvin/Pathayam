# Connecting an AI

Claude, ChatGPT, Gemini and any other client of the
[Model Context Protocol](https://modelcontextprotocol.io) can read the budget
and answer questions from it. The app is its own MCP server, at
`<BASE_URL>/mcp`. There is no separate process, and nothing is sent anywhere
until a member connects an app.

- [What a connection can do](#what-a-connection-can-do)
- [Connecting](#connecting)
- [Tools](#tools)
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
| **Reads** | Only. No tool writes, and the token behind every connection is read-scope. |
| **Sees** | What the member who connected it sees: the household budget and their own personal budget. Another member's private accounts, loans, policies and envelopes are never listed, counted or totalled ([privacy.md](privacy.md)). An id it may not see is "not found", the same as one that does not exist. |
| **Cannot reach** | Anything a token cannot reach ([API.md](API.md#what-a-token-can-never-reach)): sign-in, tokens, the member list, impersonation, OAuth approval, and the Connect an AI page itself. |
| **Leaves** | A line per question in the access log. The answers are not kept. |

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

## Masking

On by default for a new connection, chosen per connection. Before an answer
leaves, in every string except the app's own ids and dates:

- digit runs of nine or more (account, card and phone numbers, UPI
  references) keep their last four digits;
- UPI IDs and email addresses keep only what follows the `@`;
- PAN numbers are masked whole.

Amounts, envelope names and payee names are the analysis and are sent. It is
best effort: a person's name written into a narration is not something a
pattern recognises.

## What they have read

The page lists each connection's questions, newest first: when, which app,
which tool, its arguments, and the size of the answer or that it was refused.
A member sees only their own connections'. Rows are kept for 90 days, at most
2,000 a member (`ai_access_log`, migration 0071). Reads are not in the activity
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
| `src/ai/analysis.ts` | The reads, one per tool. |
| `src/ai/redact.ts` | Masking. |
| `src/ai/access-log.ts` | The access log. |
| `src/auth/oauth.ts` | Signing in from an AI app. |
| `src/web/pages/ai.ts` | The Connect an AI page. |
