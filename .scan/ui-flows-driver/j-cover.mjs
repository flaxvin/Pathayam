// Journey: cover an overspend from RTA via the suggested-source button; then hold; then copy last month on next month; then auto-assign page
import { open } from './lib.mjs';
const member = process.argv[2] || 'Ravi';
const s = await open(member);
const { page } = s;
const settle = async () => { await page.waitForTimeout(300); await page.waitForLoadState('networkidle'); await page.waitForTimeout(1200); };
const rta = async () => (await s.txt()).match(/Ready to Assign\n(-?₹[\d,.]+)/)?.[1];
const notices = async () => (await page.$$eval('main [role=status], main .notice', es => es.map(e => e.textContent.trim().replace(/\s+/g, ' ')).filter(Boolean).filter(t => !t.includes('funded yet'))));
const row = async (name) => page.$eval(`.category-row[data-category-name="${name}"]`, e => e.innerText.replace(/\s+/g, ' ')).catch(() => 'no row ' + name);
await s.go('/');
console.log('RTA0', await rta(), '|', await row('Domestic help'));
await page.locator('.category-row[data-category-name="Domestic help"] >> text=/Cover/').first().click();
await settle();
console.log('amount prefilled:', await page.$eval('#move-amount', e => e.value));
await page.click('main button[name=from_category_id][value=rta]');
await settle();
console.log('cover: url', page.url(), '| notices', await notices());
console.log('RTA1', await rta(), '|', await row('Domestic help'));
// hold
await s.go('/hold');
console.log((await s.txt()).slice(0, 600));
await page.fill('main form[action="/hold"] input[name=amount]', '2000');
await page.click('main form[action="/hold"] button[type=submit]');
await settle();
console.log('hold: url', page.url(), '| notices', await notices(), '| RTA', await rta());
// next month view
await s.go('/?month=2026-11');
console.log('Nov RTA', await rta());
console.log((await s.txt()).slice(0, 700));
console.log('PROBLEMS', s.problems);
await s.browser.close();
