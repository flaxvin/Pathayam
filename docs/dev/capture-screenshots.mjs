/**
 * Regenerate docs/screenshots/*.png against a running dev instance.
 *
 *   npm run seed                       # a demo household with real behaviour
 *   DEV_LOGIN=1 PORT=8914 npm run dev  # the auth bypass, locally only
 *   node docs/dev/capture-screenshots.mjs --port 8914
 *
 * Chromium is driven over the DevTools protocol directly rather than through a
 * driver library, because B1 says zero runtime dependencies and that is worth
 * keeping true of the tooling as well. It signs in through POST /auth/dev, so
 * it only ever works against an instance that has deliberately enabled the
 * bypass — never production, where the module is not even present (R38.5).
 *
 * Deterministic by construction: a fixed viewport, a fixed device scale, and a
 * wait for fonts and layout to settle, so a re-run produces the same image
 * unless the screen actually changed.
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "screenshots");

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const PORT = Number(argOf("port", "8914"));
const BASE = `http://127.0.0.1:${PORT}`;
const WIDTH = Number(argOf("width", "1440"));
const HEIGHT = Number(argOf("height", "900"));
const SCALE = Number(argOf("scale", "2"));
const ONLY = argOf("only", null);

/** Each entry is [file, path]. `full` captures the whole scroll height. */
const SHOTS = [
  ["budget", "/", { full: true }],
  ["overview", "/overview", { full: true }],
  ["accounts", "/accounts"],
  ["cards", "/cards", { full: true }],
  ["review", "/review"],
  ["reports", "/reports", { full: true }],
  ["goals", "/goals"],
  ["schedules", "/schedules"],
  ["loans", "/loans"],
  ["portfolio", "/portfolio"],
  ["net-worth", "/net-worth", { full: true }],
  ["allocation", "/portfolio/allocation", { full: true }],
  ["import", "/import"],
  ["health", "/health", { full: true }],
  ["settings", "/settings", { full: true }],
  ["categories", "/categories"],
  ["activity", "/activity"],
];

/**
 * Chart crops, addressed by the card's heading rather than a CSS selector —
 * a heading is what the screen actually promises, and it survives a class
 * rename. `:loan` is filled in from the first loan on /loans.
 */
const CHART_SHOTS = [
  ["charts_allocation", "/portfolio/allocation", ["By class", "By geography", "By currency"]],
  ["charts_reports", "/reports", ["Income and spending"]],
  ["charts_cashflow", "/schedules", ["The next 60 days"]],
  ["charts_goals", "/goals", null],
  ["charts_loan", "/loans/:loan", null],
];

function findChromium() {
  const candidates = [
    "/usr/bin/chromium", "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome",
    "/snap/bin/chromium",
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error("No Chromium found. Install chromium, or pass --chrome <path>.");
  return argOf("chrome", found);
}

// --- A very small CDP client. One WebSocket, ids in, results out. ------------

async function connect(wsUrl) {
  const socket = new WebSocket(wsUrl);
  await new Promise((ok, fail) => {
    socket.addEventListener("open", ok, { once: true });
    socket.addEventListener("error", () => fail(new Error("CDP connect failed")), { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.fail(new Error(message.error.message));
    else waiter.ok(message.result);
  });

  return {
    send(method, params = {}) {
      const id = nextId++;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((ok, fail) => pending.set(id, { ok, fail }));
    },
    close: () => socket.close(),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // Refuse early rather than writing 16 screenshots of a sign-in page.
  const probe = await fetch(`${BASE}/signin`).catch(() => null);
  if (!probe?.ok) throw new Error(`Nothing is serving ${BASE}. Start the dev server first.`);

  const signin = await probe.text();
  const memberId = signin.match(/<option value="([^"]+)"/)?.[1];
  if (!memberId) {
    throw new Error("No development sign-in form. Start the server with DEV_LOGIN=1.");
  }

  const auth = await fetch(`${BASE}/auth/dev`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ member_id: memberId }),
    redirect: "manual",
  });
  const cookie = auth.headers.getSetCookie?.()[0]?.split(";")[0];
  if (!cookie) throw new Error("Development sign-in did not return a session cookie.");

  mkdirSync(OUT, { recursive: true });

  const userDataDir = join(process.env.TMPDIR ?? "/tmp", `budget-shots-${process.pid}`);
  const chrome = spawn(findChromium(), [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    "--no-first-run", "--no-default-browser-check",
    "--hide-scrollbars", "--force-color-profile=srgb",
    "--disable-gpu", "--disable-dev-shm-usage",
    `--window-size=${WIDTH},${HEIGHT}`,
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });

  // Chromium prints the DevTools endpoint on stderr once it is listening.
  const wsUrl = await new Promise((ok, fail) => {
    let buffer = "";
    const timer = setTimeout(() => fail(new Error("Chromium did not report a DevTools endpoint.")), 20000);
    chrome.stderr.on("data", (chunk) => {
      buffer += chunk;
      const match = buffer.match(/ws:\/\/[^\s]+/);
      if (match) { clearTimeout(timer); ok(match[0]); }
    });
    chrome.on("exit", (code) => { clearTimeout(timer); fail(new Error(`Chromium exited (${code})`)); });
  });

  // The endpoint on stderr is the *browser* target, which carries no Page or
  // Runtime domain. The page's own socket is listed at /json/list on the same
  // host and port.
  const origin = new URL(wsUrl).host;
  const pageWs = await (async () => {
    for (let attempt = 0; attempt < 40; attempt++) {
      const list = await fetch(`http://${origin}/json/list`).then((r) => r.json()).catch(() => []);
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
      await sleep(150);
    }
    throw new Error("Chromium never reported a page target.");
  })();

  const cdp = await connect(pageWs);
  await cdp.send("Page.enable");
  await cdp.send("Network.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: WIDTH, height: HEIGHT, deviceScaleFactor: SCALE, mobile: false,
  });

  const [name, value] = cookie.split("=");
  await cdp.send("Network.setCookie", {
    name, value, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax",
  });

  async function goto(path) {
    await cdp.send("Page.navigate", { url: BASE + path });

    // Wait for the load event, then for fonts, so text is never captured
    // mid-swap.
    await new Promise((ok) => {
      const timer = setTimeout(ok, 10000);
      cdp.send("Runtime.evaluate", {
        expression: `new Promise(r => {
          if (document.readyState === "complete") return r(1);
          window.addEventListener("load", () => r(1), { once: true });
        })`,
        awaitPromise: true,
      }).then(() => { clearTimeout(timer); ok(); }).catch(() => { clearTimeout(timer); ok(); });
    });
    await cdp.send("Runtime.evaluate", {
      expression: "document.fonts ? document.fonts.ready.then(()=>1) : 1",
      awaitPromise: true,
    }).catch(() => {});

    // The bypass banner is a property of *this* machine, not of the app, and a
    // screenshot of it in the README would document something no reader has.
    await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        document.querySelectorAll(".banner-dev").forEach(el => el.remove());
        return 1;
      })()`,
    }).catch(() => {});
    await sleep(250);
  }

  const shots = ONLY ? SHOTS.filter(([file]) => file === ONLY) : SHOTS;
  for (const [file, path, opts = {}] of shots) {
    await goto(path);

    let clip;
    if (opts.full) {
      const { result } = await cdp.send("Runtime.evaluate", {
        expression: `JSON.stringify({ h: Math.min(document.documentElement.scrollHeight, 6000) })`,
        returnByValue: true,
      });
      const { h } = JSON.parse(result.value);
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: WIDTH, height: h, deviceScaleFactor: SCALE, mobile: false,
      });
      await sleep(150);
      // scale stays 1: the resolution comes from deviceScaleFactor, and setting
      // both multiplies them into an image four times the size it should be.
      clip = { x: 0, y: 0, width: WIDTH, height: h, scale: 1 };
    }

    const { data } = await cdp.send("Page.captureScreenshot", {
      format: "png", captureBeyondViewport: Boolean(opts.full), ...(clip ? { clip } : {}),
    });
    writeFileSync(join(OUT, `${file}.png`), Buffer.from(data, "base64"));
    console.log(`  ${file}.png  ← ${path}`);

    if (opts.full) {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: WIDTH, height: HEIGHT, deviceScaleFactor: SCALE, mobile: false,
      });
    }
  }

  // --- Chart crops ----------------------------------------------------------

  // The loan chart needs a real loan; take the first one the demo household has.
  const loansPage = await fetch(`${BASE}/loans`, { headers: { Cookie: cookie } }).then((r) => r.text());
  const loanId = loansPage.match(/href="\/loans\/([0-9a-f-]{36})"/)?.[1] ?? null;

  const charts = ONLY ? CHART_SHOTS.filter(([file]) => file === ONLY) : CHART_SHOTS;
  let chartCount = 0;
  for (const [file, rawPath, headings] of charts) {
    if (rawPath.includes(":loan") && !loanId) {
      console.log(`  skipped ${file}.png — the demo household has no loans`);
      continue;
    }
    const path = rawPath.replace(":loan", loanId ?? "");
    await goto(path);

    // Measure the union of the named cards — or, with no names, the first card
    // on the page that actually draws something.
    const { result } = await cdp.send("Runtime.evaluate", {
      returnByValue: true,
      expression: `(() => {
        const wanted = ${JSON.stringify(headings)};
        const cards = [...document.querySelectorAll("#main section.card, #main .card")];
        const picked = wanted
          ? cards.filter(c => {
              const h = c.querySelector("h2, h3");
              return h && wanted.includes(h.textContent.trim());
            })
          : cards.filter(c => c.querySelector("svg")).slice(0, 1);
        if (!picked.length) return null;
        const boxes = picked.map(c => c.getBoundingClientRect());
        const pad = 12;
        const top = Math.min(...boxes.map(b => b.top)) - pad;
        const left = Math.min(...boxes.map(b => b.left)) - pad;
        const right = Math.max(...boxes.map(b => b.right)) + pad;
        const bottom = Math.max(...boxes.map(b => b.bottom)) + pad;
        return JSON.stringify({
          x: Math.max(0, left), y: Math.max(0, top + window.scrollY),
          width: right - Math.max(0, left), height: bottom - top,
        });
      })()`,
    });

    if (!result.value) {
      console.log(`  skipped ${file}.png — no matching card on ${path}`);
      continue;
    }
    const box = JSON.parse(result.value);

    // Grow the viewport so a tall card is not cut off by the fold.
    const tall = Math.ceil(box.y + box.height + 40);
    if (tall > HEIGHT) {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: WIDTH, height: tall, deviceScaleFactor: SCALE, mobile: false,
      });
      await sleep(150);
    }

    const { data } = await cdp.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      clip: { ...box, scale: 1 },
    });
    writeFileSync(join(OUT, `${file}.png`), Buffer.from(data, "base64"));
    console.log(`  ${file}.png  ← ${path}`);
    chartCount++;

    if (tall > HEIGHT) {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: WIDTH, height: HEIGHT, deviceScaleFactor: SCALE, mobile: false,
      });
    }
  }

  cdp.close();
  chrome.kill();
  console.log(`\n${shots.length + chartCount} screenshots written to docs/screenshots/`);
}

main().catch((err) => {
  console.error(`\n${err.message}\n`);
  process.exit(1);
});
