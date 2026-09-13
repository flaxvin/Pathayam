/**
 * Screenshots, repeatably.
 *
 * Every shot in `docs/screenshots/` and `website/img/` used to be taken by a
 * script that lived in /tmp and was rewritten from memory each time the app
 * changed. So the shots drifted: the loans page in the README showed a screen
 * without the owner column, months after the column shipped. A README that
 * shows an older app than the one you install is a small lie told at scale.
 *
 * This is that script, in the repository. Zero dependencies: headless Chromium
 * over the DevTools protocol, driven by Node's own WebSocket and fetch.
 *
 *   npm run shots                 # every shot
 *   npm run shots -- loans rate   # only those whose name matches
 *
 * It seeds a throwaway demo database, boots the app against it, captures each
 * route at 1400 CSS px and a device pixel ratio of 2, and writes a PNG for the
 * README and a WebP for the website. Nothing touches your own data.
 */

import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const PNG_DIR = join(ROOT, "docs/screenshots");
const WEBP_DIR = join(ROOT, "website/img");
const WIDTH = 1400;
const SCALE = 2;

/**
 * What to capture. `clip` narrows the shot to one element — the chart shots are
 * a chart, not the page it sits on.
 */
const SHOTS = [
  { name: "budget", path: "/" },
  { name: "overview", path: "/overview" },
  { name: "accounts", path: "/accounts" },
  { name: "cards", path: "/cards" },
  { name: "categories", path: "/categories" },
  { name: "add", path: "/add" },
  { name: "activity", path: "/activity" },
  { name: "query", path: "/query" },
  { name: "reports", path: "/reports" },
  { name: "review", path: "/review" },
  { name: "import", path: "/import" },
  { name: "schedules", path: "/schedules" },
  { name: "goals", path: "/goals" },
  { name: "household", path: "/household" },
  { name: "leaving", path: "/household", pick: "departure" },
  { name: "lending", path: "/family" },
  { name: "loans", path: "/loans" },
  { name: "loan", path: "/loans", pick: "loan" },
  { name: "loan-rate", path: "/loans", pick: "loan", suffix: "/rate" },
  { name: "loan-prepay", path: "/loans", pick: "loan", suffix: "/prepay" },
  { name: "convert-to-emi", path: "/query", pick: "card-charge" },
  { name: "portfolio", path: "/portfolio" },
  { name: "valuations", path: "/portfolio/valuations" },
  { name: "allocation", path: "/portfolio/allocation" },
  { name: "net-worth", path: "/net-worth" },
  { name: "health", path: "/health" },
  { name: "settings", path: "/settings" },
  { name: "charts_allocation", path: "/portfolio/allocation", clip: "svg" },
  { name: "charts_reports", path: "/reports", clip: "svg" },
  { name: "charts_cashflow", path: "/schedules", clip: "svg" },
  { name: "charts_goals", path: "/goals", clip: ".progress-ring" },
  { name: "charts_loan", path: "/loans", pick: "loan", clip: "svg" },
];

const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const wanted = only.length
  ? SHOTS.filter((s) => only.some((o) => s.name.includes(o)))
  : SHOTS;

const work = mkdtempSync(join(tmpdir(), "pathayam-shots-"));
const dbPath = join(work, "demo.sqlite");
let server, browser;

try {
  log(`seeding ${dbPath}`);
  execFileSync("node", ["--experimental-strip-types", "src/demo.ts"], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_PATH: dbPath, DEMO_MODE: "1" },
    stdio: "ignore",
  });

  const port = 8199;
  server = spawn("node", ["--experimental-strip-types", "src/main.ts"], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_PATH: dbPath, DEMO_MODE: "1", PORT: String(port) },
    stdio: "ignore",
  });
  const base = `http://127.0.0.1:${port}`;
  await waitFor(`${base}/signin`);

  // The demo's own front door, so the shots carry the demo banner and the
  // invented data rather than anything real.
  const entered = await fetch(`${base}/demo/enter`, { method: "POST", redirect: "manual" });
  const cookie = (entered.headers.get("set-cookie") ?? "").split(";")[0];
  if (!cookie) throw new Error("no session cookie from /demo/enter");

  /*
   * Pin the theme. The demo seeds whatever it seeds and a stray toggle sticks,
   * so without this a rerun can quietly reshoot the whole set in the other
   * theme — which shows up as a 28-file diff nobody asked for.
   */
  await fetch(`${base}/settings/theme`, {
    method: "POST", redirect: "manual",
    headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: "theme=dark",
  });

  const paths = await resolvePaths(base, cookie);

  const cdpPort = 9333;
  browser = spawn("chromium", [
    "--headless=new",
    `--remote-debugging-port=${cdpPort}`,
    "--hide-scrollbars",
    "--force-color-profile=srgb",
    "--disable-gpu",
    "--no-sandbox",
    `--user-data-dir=${join(work, "chrome")}`,
    "about:blank",
  ], { stdio: "ignore" });

  const cdp = await connectCdp(cdpPort);
  await cdp.send("Page.enable");
  await cdp.send("Network.enable");
  await cdp.send("Network.setCookie", {
    name: cookie.split("=")[0],
    value: cookie.split("=").slice(1).join("="),
    domain: "127.0.0.1",
    path: "/",
  });

  mkdirSync(PNG_DIR, { recursive: true });
  mkdirSync(WEBP_DIR, { recursive: true });

  for (const shot of wanted) {
    const path = shot.pick ? paths[shot.pick] : shot.path;
    if (!path) {
      log(`skipped ${shot.name} — the demo has nothing to point it at`);
      continue;
    }
    const url = base + path + (shot.suffix ?? "");
    await capture(cdp, url, shot);
    log(`${shot.name}  ←  ${path}${shot.suffix ?? ""}`);
  }
} finally {
  browser?.kill();
  server?.kill();
  rmSync(work, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------

/**
 * Ids the demo generates freshly each run, so a shot can say "a loan" rather
 * than carrying a uuid that will not exist next time.
 */
async function resolvePaths(base, cookie) {
  const get = async (p) => (await fetch(base + p, { headers: { Cookie: cookie } })).text();

  const loans = await get("/loans");
  const loan = loans.match(/\/loans\/([0-9a-f-]{36})/)?.[1];

  const settings = await get("/settings");
  const departure = settings.match(/\/members\/([0-9a-z-]+)\/remove/)?.[1];

  // A charge on a credit account, which is the only kind that can convert.
  const query = await get("/query?kind=credit");
  const charge = query.match(/\/transaction\/([0-9a-f-]{36})/)?.[1];

  return {
    loan: loan ? `/loans/${loan}` : null,
    departure: departure ? `/members/${departure}/remove` : null,
    "card-charge": charge ? `/transaction/${charge}` : null,
  };
}

async function capture(cdp, url, shot) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: WIDTH, height: 1000, deviceScaleFactor: SCALE, mobile: false,
  });
  await cdp.send("Page.navigate", { url });
  await cdp.waitForLoad();
  // Charts and fonts settle a frame or two after load.
  await new Promise((r) => setTimeout(r, 400));

  let params = { format: "png", captureBeyondViewport: true };
  if (shot.clip) {
    const box = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(shot.clip)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return JSON.stringify({
          x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height,
        });
      })()`,
      returnByValue: true,
    });
    const rect = box.result.value ? JSON.parse(box.result.value) : null;
    if (!rect) throw new Error(`${shot.name}: nothing matched ${shot.clip}`);
    // The device scale factor already doubles it; a clip scale would double it twice.
    params.clip = { ...rect, scale: 1 };
  } else {
    const metrics = await cdp.send("Page.getLayoutMetrics");
    const size = metrics.cssContentSize ?? metrics.contentSize;
    params.clip = { x: 0, y: 0, width: WIDTH, height: Math.ceil(size.height), scale: 1 };
  }

  const { data } = await cdp.send("Page.captureScreenshot", params);
  const png = join(PNG_DIR, `${shot.name}.png`);
  writeFileSync(png, Buffer.from(data, "base64"));
  execFileSync("cwebp", ["-quiet", "-q", "82", png, "-o", join(WEBP_DIR, `${shot.name}.webp`)]);
}

async function waitFor(url) {
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error(`${url} never came up`);
}

/** The smallest CDP client that will do: one target, one socket, ids and promises. */
async function connectCdp(port) {
  let targets;
  for (let i = 0; i < 100; i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      if (targets.some((t) => t.type === "page")) break;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  const page = targets.find((t) => t.type === "page");
  if (!page) throw new Error("chromium never opened a page");

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((ok, fail) => {
    ws.addEventListener("open", ok, { once: true });
    ws.addEventListener("error", fail, { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  let loaded = null;

  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { ok, fail } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? fail(new Error(msg.error.message)) : ok(msg.result);
    }
    if (msg.method === "Page.loadEventFired" && loaded) loaded();
  });

  return {
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((ok, fail) => {
        pending.set(id, { ok, fail });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    waitForLoad() {
      return new Promise((ok) => {
        loaded = () => { loaded = null; ok(); };
        setTimeout(() => { loaded = null; ok(); }, 10_000);
      });
    },
  };
}

function log(message) {
  process.stdout.write(`  ${message}\n`);
}
