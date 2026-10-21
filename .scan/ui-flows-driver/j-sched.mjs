// Journey: Schedules → mark the first schedule arrived/paid, then skip; read RTA and the schedule line back
import { open } from './lib.mjs';
const [member = 'Anil', button = 'Arrived'] = process.argv.slice(2);
const s = await open(member);
const { page } = s;
const settle = async () => { await page.waitForTimeout(300); await page.waitForLoadState('networkidle'); await page.waitForTimeout(1200); };
const rta = async () => { await s.go('/'); return (await s.txt()).match(/Ready to Assign\n(-?₹[\d,.]+)/)?.[1]; };
const line = async () => { await s.go('/schedules'); return (await s.txt()).split('Schedules\nAdd one\n')[1]?.split('Look like')[0].replace(/\s+/g, ' '); };
console.log('BEFORE', await rta(), '|', await line());
await s.go('/schedules');
await page.locator(`main form button:has-text("${button}")`).first().click();
await settle();
console.log('url', page.url(), 'notices', await page.$$eval('main [role=status]', es => es.map(e => e.textContent.trim())));
console.log('AFTER', await rta(), '|', await line());
console.log('PROBLEMS', s.problems);
await s.browser.close();
