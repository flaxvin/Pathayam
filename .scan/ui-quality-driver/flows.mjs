// Theme toggle, member switching on one device, back-after-signout, offline.
import { chromium } from "playwright-core";
const BASE = "http://localhost:8208";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const log = (...a) => console.log(...a);

async function signIn(page, member) {
  await page.goto(BASE + "/signin");
  if (await page.$("#demo-member")) await page.selectOption("#demo-member", { label: member });
  await Promise.all([page.waitForNavigation(), page.click("form[action='/demo/enter'] button")]);
}
const themeState = (page) => page.evaluate(() => ({
  attr: document.documentElement.getAttribute("data-theme"),
  bg: getComputedStyle(document.body).backgroundColor,
  toggle: document.querySelector("form[action='/settings/theme'] button")?.getAttribute("aria-label"),
}));

// 1. Theme toggle with OS in dark mode and member theme "system"
for (const scheme of ["dark", "light"]) {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, colorScheme: scheme, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await signIn(page, "Anil");
  log(`[theme ${scheme} OS] before`, await themeState(page));
  await page.click("form[action='/settings/theme'] button"); await page.waitForTimeout(1200);
  log(`[theme ${scheme} OS] after 1 click`, await themeState(page));
  await page.goto(BASE + "/accounts");
  log(`[theme ${scheme} OS] after nav`, await themeState(page));
  await page.click("form[action='/settings/theme'] button"); await page.waitForTimeout(1200);
  log(`[theme ${scheme} OS] after 2 clicks`, await themeState(page));
  // reset to system
  await page.goto(BASE + "/settings");
  await page.screenshot({ path: `/home/user/Pathayam/.scan/screens/ui-quality/theme-${scheme}.png` });
  await ctx.close();
}

// 2. Member switch on one device: Ravi -> sign out -> Priya; back button
{
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await signIn(page, "Ravi");
  await page.goto(BASE + "/accounts");
  const raviAccounts = await page.evaluate(() => document.querySelector("main").innerText.slice(0, 300));
  // sign out
  const so = await page.$("form[action='/signout'] button");
  log("[switch] signout control on /accounts?", !!so);
  if (!so) await page.goto(BASE + "/settings");
  await Promise.all([page.waitForNavigation(), page.click("form[action='/signout'] button")]);
  log("[switch] after signout url", page.url());
  await page.goBack().catch((e) => log("goBack err", e.message));
  log("[switch] after back url", page.url(), "shows:", (await page.evaluate(() => document.querySelector("main")?.innerText ?? document.body.innerText)).slice(0, 120).replace(/\n/g, " | "));
  await signIn(page, "Priya");
  await page.goto(BASE + "/accounts");
  const header = await page.evaluate(() => document.querySelector("header")?.innerText.replace(/\n/g, " | "));
  log("[switch] Priya header", header);
  // 3. offline
  await ctx.setOffline(true);
  const r = await page.goto(BASE + "/accounts").then(() => "loaded").catch((e) => "error: " + e.message.split("\n")[0]);
  log("[offline] navigation", r);
  await ctx.setOffline(false);
  await ctx.close();
}
await browser.close();
