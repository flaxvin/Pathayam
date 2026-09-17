# Deploying the website

The site is static: HTML, one stylesheet, one script, images and fonts. Any
static host serves it. Nothing here needs a build step.

```
pathayam.app         →  this directory, on a static host
demo.pathayam.app    →  the application itself, in DEMO_MODE
```

---

## 1 · Make the waitlist button live

Until this is done the button refuses politely and sends nothing: `site.js`
checks `WAITLIST_ENDPOINT` and says *"The waitlist is not connected yet —
nothing was sent."* That is deliberate, so a signup box can never silently
swallow an address.

The whole backend is a Google Sheet plus a bound Apps Script
([`waitlist.gs`](waitlist.gs)). No server, no database, no form service holding
the list.

1. **Create the sheet.** A new Google Sheet. Rename the first tab to exactly
   `Waitlist` — the script looks for that name and will create it if missing,
   but matching it keeps the setup obvious.

2. **Add the script.** In that sheet: **Extensions → Apps Script**. Delete the
   placeholder `myFunction`, paste the entire contents of
   [`waitlist.gs`](waitlist.gs), and save.

3. **Run `setUpSheet` once.** Choose it in the function dropdown and press Run.
   Google asks for permission the first time; grant it. This writes the bold,
   frozen header row: `Joined (IST) · Email · Tier · Page · Source`. Skipping
   this still works, but the columns arrive unlabelled.

4. **Deploy as a web app.** **Deploy → New deployment → Web app**.

   | Setting | Value | Why |
   |---|---|---|
   | Execute as | **Me** | The script writes to *your* sheet. |
   | Who has access | **Anyone** | The browser posts without a Google account. |

   Copy the `/exec` URL it gives you. It ends in `/exec`, not `/dev` — the
   `/dev` URL only works while you are signed in, which is the usual reason a
   deployment appears to work for you and for nobody else.

5. **Put the URL in the site.** In [`site.js`](site.js), set:

   ```js
   var WAITLIST_ENDPOINT = "https://script.google.com/macros/s/AKfy…/exec";
   ```

   Republish the site.

### Checking it worked

Submit a real address on the live site, then look at the sheet. A row should
appear within a second or two.

Two things worth knowing before you trust what the page tells you:

- The request is sent `mode: "no-cors"`, because Apps Script sends no CORS
  headers. The response is therefore **opaque**: the page says "You are on the
  list" when the request *left the browser*, not when the row was written. The
  sheet is the truth, not the message.
- A submission whose hidden `company` field is filled is dropped silently. That
  field is a bot trap no human sees, so anything filling it is not a person.

### Re-deploying after an edit

Apps Script serves the **deployed** version, not the saved one. After editing
`waitlist.gs`: **Deploy → Manage deployments → edit → Version: New version →
Deploy**. Editing without redeploying is the usual reason a change appears to
do nothing.

### What the sheet holds

An email address, the tier the person was looking at, the page they submitted
from, and an IST timestamp. Nothing that identifies a device — no IP, no
cookie. Duplicate addresses are updated in place rather than appended, so the
sheet stays a list of people rather than a log of clicks. This matches what
[`privacy.html`](privacy.html) promises; if you change the script to store
more, change that page too.

---

## 2 · Before the site goes public

### Fill in the legal placeholders

[`privacy.html`](privacy.html) and [`terms.html`](terms.html) carry facts only
you can supply. Each is wrapped in a dashed gold `TODO` chip, so they are
impossible to miss on the rendered page. Search both files for `class="todo"`:

| Placeholder | Needed for |
|---|---|
| `[LEGAL ENTITY NAME]`, `[REGISTERED ADDRESS]` | Both pages. Who the contract is with. |
| `[GRIEVANCE OFFICER NAME]` | Required under the DPDP Act and the IT Rules. |
| `[HOSTING PROVIDER]`, `[HOSTING PROVIDER AND REGION]`, `[N]` days | Privacy: sub-processors and log retention. |
| `[PAYMENT PROCESSOR]` | Both pages. |
| `[INCLUSIVE / EXCLUSIVE]` of GST | Terms: pricing. |
| `[CITY]` | Terms: jurisdiction. |
| `[LINK TO THE PUBLIC REPOSITORY]` | Terms: where the licence text lives, once the repository is public. |

Have a lawyer read both pages before taking a single payment. They are written
to be accurate about what the software does — which is the part that is hard to
get right — but they are not legal advice, and taking money for a service in
India brings in consumer protection, GST and the DPDP Act all at once.

### Set up the domains

| Host | Serves | Notes |
|---|---|---|
| `pathayam.app` | this directory | Static. Redirect `www` to the apex. |
| `demo.pathayam.app` | the app, `DEMO_MODE=1` | Reseed on a schedule; the data is public. |

Serve both over HTTPS and redirect HTTP. `BASE_URL` on the demo must be exactly
`https://demo.pathayam.app` — sign-in redirects and cookie scoping depend on
it being right.

Recommended response headers for the static site:

```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://script.google.com; form-action 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: same-origin
Strict-Transport-Security: max-age=31536000; includeSubDomains
```

`connect-src` has to allow `script.google.com` once the waitlist is live: the
form is submitted with `fetch`, so that directive is the one that governs it.
Without it the browser blocks the request and the page reports a failure it
cannot explain.

### Check nothing leaks

The site loads no third-party resource: fonts are served from
[`fonts/`](fonts/) and there is no analytics, no tag manager and no embed. Keep
it that way — `privacy.html` says so in as many words. To confirm after a
change, open any page and run:

```js
performance.getEntriesByType("resource").filter(r => !r.name.startsWith(location.origin))
```

An empty array is the expected answer.

---

## 3 · Publishing

The site publishes itself from GitHub. `.github/workflows/pages.yml` copies this
directory to GitHub Pages on every push to `main` that touches it.

**One-time setup:** in the repository, **Settings → Pages → Source → GitHub
Actions**. Until that is set the workflow runs and fails at the last step.

The workflow refuses to publish if either check fails:

- any legal page still contains a `TODO` placeholder;
- any file references a third-party host, which `privacy.html` promises it does
  not.

It first publishes at `https://flaxvin.github.io/Pathayam/`. Relative links
throughout mean the sub-path works as-is.

### Moving it to pathayam.app

1. At your DNS provider, for the apex `pathayam.app`:

   ```
   A     @   185.199.108.153
   A     @   185.199.109.153
   A     @   185.199.110.153
   A     @   185.199.111.153
   AAAA  @   2606:50c0:8000::153
   AAAA  @   2606:50c0:8001::153
   AAAA  @   2606:50c0:8002::153
   AAAA  @   2606:50c0:8003::153
   CNAME www flaxvin.github.io.
   ```

2. In **Settings → Pages**, set the custom domain and tick **Enforce HTTPS**
   once the certificate is issued. Setting it there makes GitHub commit a
   `CNAME` file to the repository root.

**`website/CNAME` has to exist as well.** This workflow uploads `website/` as
the artifact, and Pages reads `CNAME` from the artifact it serves — a file at
the repository root is not in it. Both files are committed and must stay in
step; changing the domain means changing both.

`demo.pathayam.app` is a separate host — the application itself, not this
directory. Point it at wherever the app runs and leave it out of DNS for Pages.

Worth re-running after any change to the markup or the stylesheet: the
accessibility and contrast audit, and the horizontal-overflow sweep across
widths. Both live outside the repository; what they check is contrast against
actual backgrounds, tap-target size, heading order, duplicate ids, alt text,
and that no page scrolls sideways between 320px and 1920px.
