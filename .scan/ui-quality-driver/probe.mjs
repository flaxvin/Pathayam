// node probe.mjs <member> <WxH:theme> <path> <js-expression evaluated in page> [screenshot]
import { chromium } from "playwright-core";
const BASE = "http://localhost:8208";
const [member, combo, path, expr, shot] = process.argv.slice(2);
const [vp, theme] = combo.split(":"); const [w, h] = vp.split("x").map(Number);
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: theme, isMobile: w < 500, hasTouch: w < 500 });
const page = await ctx.newPage();
page.on("console", (m) => console.log("CONSOLE", m.type(), m.text().slice(0, 300), JSON.stringify(m.location())));
page.on("response", (r) => { if (r.status() >= 400) console.log("HTTP", r.status(), r.url()); });
await page.goto(BASE + "/signin");
if (await page.$("#demo-member")) await page.selectOption("#demo-member", { label: member });
await Promise.all([page.waitForNavigation(), page.click("form[action='/demo/enter'] button")]);
await page.goto(BASE + path);
if (expr) console.log(JSON.stringify(await page.evaluate(expr), null, 1));
if (shot) await page.screenshot({ path: shot, fullPage: false });
await browser.close();
