// ui-quality crawler: node audit.mjs <member-name> <out.json> [maxPages]
import { chromium } from "playwright-core";
import { writeFileSync } from "node:fs";

const BASE = "http://localhost:8208";
const MEMBER = process.argv[2] ?? "Ravi";
const OUT = process.argv[3] ?? "out.json";
const MAX = Number(process.argv[4] ?? 200);
const COMBOS = (process.env.COMBOS ?? "375x812:light,375x812:dark,1400x900:light,1400x900:dark").split(",");

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });

async function signIn(ctx) {
  const page = await ctx.newPage();
  await page.goto(BASE + "/signin");
  const sel = await page.$("#demo-member");
  if (sel) await page.selectOption("#demo-member", { label: MEMBER });
  await Promise.all([page.waitForNavigation(), page.click("form[action='/demo/enter'] button")]);
  await page.close();
}

// normalise ids so we visit one page per template
const template = (p) => p.replace(/\/[0-9a-f]{8,}[0-9a-f-]*/gi, "/:id").replace(/\/\d+(?=\/|$)/g, "/:n");
const SKIP = /^\/(signout|auth|gmail|export|demo|impersonate)|\.csv|\.json|\/attachment\//;

const CHECK = () => {
  const out = { overflow: [], tap: [], contrast: [], labels: [], dupIds: [], headings: [], fmt: [] };
  const vw = document.documentElement.clientWidth;
  out.docScroll = document.documentElement.scrollWidth - vw;
  const visible = (el) => { const d = el.closest("details:not([open])"); if (d && !(el.closest("summary") && el.closest("summary").parentElement === d)) return false; const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
  const desc = (el) => { let s = el.tagName.toLowerCase(); if (el.id) s += "#" + el.id; if (el.className && typeof el.className === "string") s += "." + el.className.trim().split(/\s+/).slice(0, 2).join("."); return s + " «" + (el.innerText || el.value || el.getAttribute("aria-label") || "").trim().slice(0, 40) + "»"; };
  const inScroller = (el) => { for (let p = el.parentElement; p; p = p.parentElement) { const s = getComputedStyle(p); if (/(auto|scroll|hidden)/.test(s.overflowX) && p !== document.documentElement && p !== document.body) return true; } return false; };
  for (const el of document.body.querySelectorAll("*")) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if ((r.right > vw + 1 || r.left < -1) && !inScroller(el) && getComputedStyle(el).position !== "fixed") out.overflow.push(desc(el) + ` [${Math.round(r.left)}..${Math.round(r.right)}]`);
  }
  // tap targets
  for (const el of document.querySelectorAll("a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button]")) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.height >= 44 && r.width >= 44) continue;
    // inline links in running text are exempt (WCAG 2.5.8)
    const inline = el.tagName === "A" && getComputedStyle(el).display === "inline" && el.parentElement && /^(P|LI|SPAN|TD|SMALL|DD|LABEL|EM|STRONG|FIGCAPTION)$/.test(el.parentElement.tagName) && (el.parentElement.innerText || "").trim().length > (el.innerText || "").trim().length + 3;
    if (inline) continue;
    if (el.type === "checkbox" || el.type === "radio") { const l = el.closest("label") || (el.id && document.querySelector(`label[for="${el.id}"]`)); if (l) { const lr = l.getBoundingClientRect(); if (lr.height >= 44) continue; } }
    out.tap.push(desc(el) + ` ${Math.round(r.width)}x${Math.round(r.height)}`);
  }
  // contrast
  const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) { return null; } const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const bgOf = (el) => { const layers = []; for (let p = el; p; p = p.parentElement) { const s = getComputedStyle(p); if (s.backgroundImage && s.backgroundImage !== "none") return null; const c = parse(s.backgroundColor); if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; } } let base = { r: 255, g: 255, b: 255 }; for (const l of layers.reverse()) base = { r: l.r * l.a + base.r * (1 - l.a), g: l.g * l.a + base.g * (1 - l.a), b: l.b * l.a + base.b * (1 - l.a) }; return base; };
  const seen = new Set();
  for (const el of document.body.querySelectorAll("*")) {
    if (!visible(el)) continue;
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!own) continue;
    if (el.closest("svg")) continue;
    const s = getComputedStyle(el);
    const fg = parse(s.color); const bg = bgOf(el); if (!fg || !bg) continue;
    let opacity = 1; for (let p = el; p; p = p.parentElement) opacity *= Number(getComputedStyle(p).opacity);
    const a = fg.a * opacity; const f = { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a) };
    const L1 = lum(f), L2 = lum(bg); const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const size = parseFloat(s.fontSize); const bold = Number(s.fontWeight) >= 700; const large = size >= 24 || (bold && size >= 18.66);
    const need = large ? 3 : 4.5;
    if (el.disabled || el.closest("[disabled]")) continue;
    if (ratio < need) { const k = desc(el) + ` ${ratio.toFixed(2)}`; if (!seen.has(k)) { seen.add(k); out.contrast.push(k + ` fg=${s.color} bg=rgb(${bg.r|0},${bg.g|0},${bg.b|0})`); } }
  }
  // labels
  for (const el of document.querySelectorAll("input:not([type=hidden]):not([type=submit]):not([type=button]), select, textarea")) {
    const has = el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || el.closest("label") || (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) || el.title;
    if (!has) out.labels.push("unlabelled " + desc(el) + " name=" + el.name);
  }
  for (const el of document.querySelectorAll("button, a[href]")) { if (!visible(el)) continue; const name = (el.innerText || "").trim() || el.getAttribute("aria-label") || el.title || el.querySelector("img[alt]")?.alt || el.querySelector("svg title")?.textContent; if (!name) out.labels.push("nameless " + desc(el) + " " + (el.getAttribute("href") || "")); }
  for (const el of document.querySelectorAll("img:not([alt])")) out.labels.push("img no alt " + el.src);
  for (const el of document.querySelectorAll("svg")) { if (!visible(el)) continue; const r = el.getBoundingClientRect(); if (r.width > 60 && !el.getAttribute("aria-label") && !el.getAttribute("aria-hidden") && !el.querySelector("title") && !el.getAttribute("role")) out.labels.push(`svg chart without name ${Math.round(r.width)}x${Math.round(r.height)} ` + (el.parentElement?.className || "")); }
  // dup ids
  const ids = {}; for (const el of document.querySelectorAll("[id]")) ids[el.id] = (ids[el.id] || 0) + 1; out.dupIds = Object.entries(ids).filter(([, n]) => n > 1).map(([k, n]) => `${k}×${n}`);
  // headings
  const hs = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")].filter(visible).map((h) => Number(h.tagName[1]));
  if (hs.filter((h) => h === 1).length !== 1) out.headings.push(`h1 count ${hs.filter((h) => h === 1).length}`);
  for (let i = 1; i < hs.length; i++) if (hs[i] > hs[i - 1] + 1) out.headings.push(`skip h${hs[i - 1]}→h${hs[i]}`);
  if (hs.length && hs[0] !== 1) out.headings.push(`first heading h${hs[0]}`);
  // formats in visible text
  const text = document.body.innerText;
  for (const m of text.matchAll(/₹\s?-?\d{1,3}(,\d{3}){2,}(\.\d+)?/g)) out.fmt.push("western grouping " + m[0]);
  for (const m of text.matchAll(/(?<![\d₹,.])\d{4,}(?:\.\d{2})?(?![\d%])/g)) { const v = m[0]; if (/^(19|20)\d\d$/.test(v)) continue; const ctx = text.slice(Math.max(0, m.index - 12), m.index + v.length + 6).replace(/\n/g, " "); if (/₹|Rs/.test(ctx) && !/\d,\d/.test(v)) out.fmt.push("ungrouped money? " + ctx); }
  for (const m of text.matchAll(/\b(19|20)\d\d-\d\d-\d\d\b/g)) { const ctx = text.slice(Math.max(0, m.index - 15), m.index + 16).replace(/\n/g, " "); out.fmt.push("ISO date " + ctx); }
  for (const m of text.matchAll(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g)) out.fmt.push("slash date " + m[0]);
  for (const m of text.matchAll(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2}, \d{4}/g)) out.fmt.push("US date " + m[0]);
  for (const m of text.matchAll(/\$\s?\d/g)) out.fmt.push("dollar " + text.slice(m.index, m.index + 12));
  for (const m of text.matchAll(/\b(NaN|undefined|null|Infinity|\[object Object\])\b/g)) out.fmt.push("junk " + text.slice(Math.max(0, m.index - 20), m.index + 15).replace(/\n/g, " "));
  out.links = [...document.querySelectorAll("a[href]")].map((a) => a.getAttribute("href")).filter((h) => h.startsWith("/") && !h.startsWith("//"));
  out.bytes = document.documentElement.outerHTML.length;
  return out;
};

const results = {};
for (const combo of COMBOS) {
  const [vp, theme] = combo.split(":");
  const [w, h] = vp.split("x").map(Number);
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: theme, isMobile: w < 500, hasTouch: w < 500 });
  await signIn(ctx);
  const page = await ctx.newPage();
  let consoleErrs = [], failed = [];
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") consoleErrs.push(m.type() + ": " + m.text().slice(0, 200)); });
  page.on("pageerror", (e) => consoleErrs.push("pageerror: " + e.message));
  page.on("requestfailed", (r) => failed.push(r.url() + " " + r.failure()?.errorText));
  page.on("response", (r) => { if (r.status() >= 400) failed.push(r.status() + " " + r.url()); });
  await page.addInitScript(() => { window.__cls = 0; new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: "layout-shift", buffered: true }); });
  const queue = ["/", "/more"]; const done = new Set(); const doneT = new Set();
  while (queue.length && done.size < MAX) {
    const path = queue.shift();
    const t = template(path.split("?")[0]) + (path.includes("?") ? "?" + [...new URLSearchParams(path.split("?")[1]).keys()].sort().join("&") : "");
    if (doneT.has(t) || SKIP.test(path)) continue;
    doneT.add(t); done.add(path);
    consoleErrs = []; failed = [];
    let resp; const t0 = Date.now();
    try { resp = await page.goto(BASE + path, { waitUntil: "load", timeout: 30000 }); } catch (e) { results[`${combo} ${path}`] = { error: e.message }; continue; }
    const timing = await page.evaluate(() => { const n = performance.getEntriesByType("navigation")[0]; return { server: Math.round(n.responseStart - n.requestStart), total: Math.round(n.loadEventEnd || (n.domContentLoadedEventEnd)), transfer: n.transferSize, decoded: n.decodedBodySize }; });
    await page.waitForTimeout(150);
    const r = await page.evaluate(CHECK);
    r.cls = await page.evaluate(() => window.__cls);
    r.status = resp?.status(); r.finalUrl = page.url().replace(BASE, ""); r.timing = timing; r.console = consoleErrs; r.failed = failed;
    for (const l of r.links) { const u = new URL(l, BASE); if (u.origin === BASE) queue.push(u.pathname + u.search); }
    delete r.links;
    results[`${combo} ${path}`] = r;
    if (process.env.SHOT) await page.screenshot({ path: `${process.env.SHOT}/${combo.replace(/[:x]/g, "_")}${path.replace(/[\/?=&]/g, "_")}.png`, fullPage: true });
  }
  await ctx.close();
}
await browser.close();
writeFileSync(OUT, JSON.stringify(results, null, 1));
console.log("pages", Object.keys(results).length);
