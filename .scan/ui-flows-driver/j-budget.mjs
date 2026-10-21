// Journey: assign inline, move, cover overspend, hold, copy last month, auto-assign; read RTA and envelopes back each time
import { open } from './lib.mjs';
const member = process.argv[2] || 'Ravi';
const s = await open(member);
const { page } = s;
const settle = async () => { await page.waitForTimeout(300); await page.waitForLoadState('networkidle'); await page.waitForTimeout(1200); };
const rta = async () => (await s.txt()).match(/Ready to Assign\n(-?₹[\d,.]+)/)?.[1];
const notices = async () => (await page.$$eval('main [role=status], main .notice', es => es.map(e => e.textContent.trim().replace(/\s+/g, ' ')).filter(Boolean)));
const row = async (name) => page.$eval(`.category-row[data-category-name="${name}"]`, e => e.innerText.replace(/\s+/g, ' ')).catch(() => 'no row ' + name);
const n = (x) => +String(x).replace(/[₹,]/g, '');
await s.go('/');
const r0 = await rta();
console.log('RTA0', r0, '| Water:', await row('Water'));
// 1. inline assign 1000 to Water
const inp = page.locator(`.category-row[data-category-name="Water"] input[name=amount]`);
await inp.click(); await inp.fill('1000'); await page.keyboard.press('Tab');
await settle();
const r1 = await rta();
console.log('assign: RTA', r1, 'delta', (n(r1) - n(r0)).toFixed(2), '| notices', await notices(), '| Water:', await row('Water'));
// 2. move 300 Water -> Broadband via /move
await s.go('/move');
const val = async (sel, label) => page.$$eval(sel + ' option', (os, l) => os.find(o => o.textContent.trim().startsWith(l))?.value, label);
await page.selectOption('#from_category_id', await val('#from_category_id', 'Water'));
await page.selectOption('#to_category_id', await val('#to_category_id', 'Broadband'));
await page.fill('#move-amount', '300');
await page.click('main form[action="/move"] button:has-text("Move it")');
await settle();
console.log('move: url', page.url(), '| notices', await notices());
await s.go('/');
console.log('after move RTA', await rta(), '| Water:', await row('Water'), '| Broadband:', await row('Broadband'));
// 3. cover Electricity
const cover = page.locator('.category-row[data-category-name="Electricity"] >> text=/Cover/').first();
console.log('cover control:', await cover.evaluate(e => e.tagName + ' ' + (e.getAttribute('href') || e.closest('form')?.action || '')).catch(e => 'none'));
await cover.click(); await settle();
console.log('cover: url', page.url(), '| notices', await notices());
console.log((await s.txt()).slice(0, 900));
await page.screenshot({ path: '/home/user/Pathayam/.claude/worktrees/agent-a004523ed47003c7f/.scratch/cover.png' });
console.log('PROBLEMS', s.problems);
await s.browser.close();
