# Forwarding address

Bank alerts and statements reach Review without Pathayam ever holding access to
a mailbox. Each member gets an address, sets one filter in their own mail, and
every message the filter forwards is read as it arrives, the same way a Gmail
fetch reads it.

```
bank ──mail──▶ member's mailbox ──filter forwards──▶ pathayam-mx (SMTP, port 25)
                                                         │  signed hand-off (INBOUND_SECRET)
                                                         ▼
                                              household app: POST /inbound/email
                                              token → member · bank sender? · bank's DKIM?
                                                         │
                                                         ▼
                                              the Gmail import's own path → Review
```

## The address

`<route>.<token>@<INBOUND_DOMAIN>`, or `<token>@<INBOUND_DOMAIN>` when the
receiver serves one instance alone (`INBOUND_ROUTE` empty).

- **One per member**, as a Gmail connection is: forwarded mail comes from
  somebody's mailbox and routes among the accounts that member can see.
- **The token is 160 random bits** (32 base32 characters). It is the only thing
  that lets mail in. Settings → Forwarding address → **Replace address** makes a
  new one, and the old one is refused at once.
- A `+tag` is ignored, so `hh1.<token>+hdfc@…` reaches the same member.
- Making, replacing and turning off an address are logged without the token,
  and are out of an API token's reach (API.md).

## What is checked, in order

| Check | Where | If it fails |
|---|---|---|
| The domain is `MX_DOMAIN` and the route is known | receiver, at `RCPT` | `550`, refused |
| The hand-off is signed with `INBOUND_SECRET`, at most five minutes old, for this recipient | app | `401`; the receiver answers `554` and logs a configuration error |
| The token names a member | app | `404`; the receiver answers `550 5.1.1` |
| The sender is one the import reads (the Gmail fetch's own sender list) | app | logged as *Not a bank sender*, not opened |
| A DKIM signature on the message passes and its `d=` is the From domain or a parent of it | app | logged as *Signature did not check out*, nothing imported |

DKIM is verified in-app (`src/mail/dkim.ts`, RFC 6376 with `rsa-sha256` and
`ed25519-sha256`; `rsa-sha1` is refused). An automatic forward (a Gmail
filter, an Outlook rule) keeps the bank's message whole, so its signature still
checks out under the forwarder's added headers. **A manual Forward rewrites the
message and breaks it**, which is why the guide on Settings asks for a filter.
SPF is not consulted: on a forwarded message it describes the forwarder, not
the bank.

The one message read from outside the sender list is Gmail's own *Forwarding
Confirmation* (from `forwarding-noreply@google.com`, signed by `google.com`).
Its code, and its link, are shown on Settings for a week, because Gmail
forwards nothing until the code is entered.

## What is kept

Nothing of a message is kept except:

- **A log line** per message in `forwarded_mail`: when, sender, subject (first
  200 characters), whether the signature checked out, and what happened.
  Settings shows the latest 20.
- **A locked statement**: a PDF no password opened is kept in
  `forwarded_statements`, sealed with `SECRETS_KEY` (AES-256-GCM, bound to its
  row and member), until it opens on **Try them again**, its member deletes it,
  or 90 days pass. Without `SECRETS_KEY` it is not kept, and the log says so.

Both tables are purged of anything older than 90 days by the six-hourly
housekeeping (`purgeForwarded`): the 90-day promise on the pricing page is
enforced in code, not a setting. All three forwarding tables are in
`NEVER_EXPORTED`.

Statement passwords use the same identity and card digits as an upload or a
Gmail fetch (Settings → Statement passwords). A SafeGold statement is not
imported from a forward, because its import waits for a person to confirm it:
the log says to upload it on Portfolio.

## Setting it up

### The app

```bash
INBOUND_DOMAIN=in.example.com
INBOUND_ROUTE=                  # empty for a receiver serving only this instance
INBOUND_SECRET=...              # openssl rand -base64 32
SECRETS_KEY=...                 # so locked statements can wait for a password
FEATURE_FORWARDING=true         # already on for selfhost; an add-on on hosted tiers
```

Checks: Settings shows **Make my forwarding address**. With the variables
missing it says *Forwarding is not set up on this server* instead, and
`POST /inbound/email` answers `503`.

### The receiver (`src/mx`)

A receive-only SMTP server with no dependencies: `EHLO`, `STARTTLS` when given a
certificate, `SIZE` (25 MiB by default), pipelining, at most 20 recipients. It
writes nothing to disk and logs envelope facts only, never a body or subject.

| Variable | Default | Notes |
|---|---|---|
| `MX_DOMAIN` | required | The `INBOUND_DOMAIN` it answers for. |
| `MX_ROUTES` | required | `{"<route>": {"url": "https://<app>", "secret": "<that app's INBOUND_SECRET>"}}`. The route `""` is the no-prefix form. Plain `http` only for localhost or a compose service name. |
| `MX_PORT` | `25` | The image runs unprivileged, so compose and Fly use `2525` inside and map 25 to it. |
| `MX_HOSTNAME` | `MX_DOMAIN` | The name in the banner and the `EHLO` reply. |
| `MX_MAX_BYTES` | `26214400` | |
| `MX_TLS_CERT`, `MX_TLS_KEY` or `MX_TLS_CERT_FILE`, `MX_TLS_KEY_FILE` | — | PEM. Both or neither. Senders such as Gmail use STARTTLS when offered; without a certificate the mail crosses the internet unencrypted. |

How the app's answer becomes the SMTP reply: `202` → `250`; `404` → `550`;
`413` → `552`; `400`/`401`/`403` → `554` and an error log line; anything else,
a timeout (30 s) or no answer → `451`, so the sender retries.

**Self-hosted, with compose:**

```bash
docker compose --profile mail up -d     # the mx service, port 25 → 2525
```

Then an `MX` record for `INBOUND_DOMAIN` pointing at the machine, and port 25
open to it. Check with `nc <host> 25` (a `220` banner) and by forwarding one
alert. Many home connections block inbound port 25; behind one, use Gmail
import instead (money-in.md).

**Hosted, on Fly.io:** `fly.mx.toml` is a separate app, deployed by hand (the
workflow deploys `fly.toml` only):

```bash
fly apps create pathayam-mx
fly ips allocate-v4 -a pathayam-mx      # a dedicated IPv4; port 25 needs one
fly secrets set -a pathayam-mx MX_ROUTES='{"hh1":{"url":"https://<app>","secret":"<INBOUND_SECRET>"}}'
fly deploy -c fly.mx.toml
```

DNS: `in.example.com. MX 10 <name resolving to that IPv4>.` Check with
`dig MX in.example.com` and `nc <ipv4> 25`.

Rollback: remove the MX record (senders queue and retry for days), then
`fly scale count 0 -a pathayam-mx`. Turning `FEATURE_FORWARDING` off on an
instance makes `/inbound/email` answer `404`, and the receiver refuses its mail.

## Code

| File | What |
|---|---|
| `src/mx/` | The receiver: SMTP, routing, the signed hand-off. |
| `src/mail/signature.ts` | The hand-off's HMAC, both sides. |
| `src/mail/mime.ts`, `src/mail/dkim.ts` | Parsing a raw message; verifying DKIM. |
| `src/forwarding/address.ts` | Tokens and addresses. |
| `src/forwarding/inbound.ts` | The checks, then `startMailIngest` from `src/gmail/fetch.ts`. |
| `src/forwarding/held.ts` | Locked statements, the log, the 90-day purge. |
| `src/web/pages/forwarding.ts` | The Settings section. |
