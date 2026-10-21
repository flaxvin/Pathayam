// Journey: hold amount H for next month, compare October and November RTA
import { open } from './lib.mjs';
const [member = 'Ravi', amt = '0'] = process.argv.slice(2);
const s = await open(member);
const { page } = s;
const settle = async () => { await page.waitForTimeout(300); await page.waitForLoadState('networkidle'); await page.waitForTimeout(1200); };
const rta = async () => (await s.txt()).match(/Ready to Assign\n(-?₹[\d,.]+)/)?.[1];
await s.go('/'); console.log('Oct before', await rta());
await s.go('/?month=2026-11'); console.log('Nov before', await rta());
await s.go('/hold');
await page.fill('main form[action="/hold"] input[name=amount]', amt);
await page.click('main form[action="/hold"] button[type=submit]');
await settle();
console.log('notice', await page.$$eval('main [role=status]', es => es.map(e => e.textContent.trim())));
await s.go('/'); console.log('Oct after', await rta());
await s.go('/?month=2026-11'); console.log('Nov after', await rta());
console.log((await s.txt()).slice(0, 400));
console.log('PROBLEMS', s.problems);
await s.browser.close();
