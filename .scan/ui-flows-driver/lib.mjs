// Shared browser driver for the ui-flows audit. Usage: import { open } from './lib.mjs'
import { createRequire } from 'node:module';
const require = createRequire('/home/user/Pathayam/.claude/worktrees/agent-a004523ed47003c7f/.scratch/node_modules/');
const { chromium } = require('playwright-core');
export const BASE = process.env.BASE || 'http://localhost:8207';
export const SHOTS = '/home/user/Pathayam/.scan/screens/ui-flows/';
export async function open(member, { demo = !process.env.DEV } = {}) {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const problems = [];
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`[console.${m.type()}] ${page.url()} ${m.text()}`); });
  page.on('pageerror', e => problems.push(`[pageerror] ${page.url()} ${e.message}`));
  page.on('requestfailed', r => problems.push(`[reqfailed] ${r.url()} ${r.failure()?.errorText}`));
  page.on('response', r => { if (r.status() >= 400) problems.push(`[http ${r.status()}] ${r.request().method()} ${r.url()}`); });
  page.on('dialog', d => d.accept());
  await page.goto(BASE + '/signin');
  if (member) {
    const sel = demo ? '#demo-member' : 'select';
    const opts = await page.$$eval(sel + ' option', os => os.map(o => [o.value, o.textContent.trim()]));
    const hit = opts.find(o => o[1].includes(member));
    if (!hit) throw new Error('no member ' + member + ' in ' + JSON.stringify(opts));
    await page.selectOption(sel, hit[0]);
    await Promise.all([page.waitForNavigation(), page.click('form:has(' + sel + ') button[type=submit]')]);
  }
  const txt = async () => (await page.innerText('main').catch(() => page.innerText('body')));
  const shot = async (name) => page.screenshot({ path: SHOTS + name + '.png' });
  const go = async (p) => { await page.goto(BASE + p); return page; };
  const submit = async (sel) => Promise.all([page.waitForNavigation(), page.click(sel)]);
  return { browser, ctx, page, problems, txt, shot, go, submit };
}
