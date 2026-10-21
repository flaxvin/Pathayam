// Journey: Loans → first loan → Record an instalment with the defaults; read outstanding before/after
import { open } from './lib.mjs';
const member = process.argv[2] || 'Ravi';
const s = await open(member);
const { page } = s;
const settle = async () => { await page.waitForTimeout(300); await page.waitForLoadState('networkidle'); await page.waitForTimeout(1200); };
await s.go('/loans');
const href = await page.$eval('main a[href^="/loans/"][href$="/pay"]', a => a.getAttribute('href')).catch(async () => (await page.$eval('main a[href^="/loans/"]:not([href*="what-if"]):not([href$="new"])', a => a.getAttribute('href'))) + '/pay');
const id = href.split('/')[2];
const outstanding = async () => { await s.go('/loans/' + id); return (await s.txt()).slice(0, 300).replace(/\s+/g, ' '); };
console.log('BEFORE', await outstanding());
await s.go('/loans/' + id + '/pay');
console.log((await s.txt()).slice(0, 700));
await page.locator('main form[action$="/pay"] button[type=submit], main form[action$="/pay"] button:not([type])').last().click();
await settle();
console.log('url', page.url(), 'notices', await page.$$eval('main [role=status], main .notice-error', es => es.map(e => e.textContent.trim())));
console.log('AFTER', await outstanding());
console.log('PROBLEMS', s.problems);
await s.browser.close();
