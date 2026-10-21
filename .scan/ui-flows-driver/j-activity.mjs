// Journey: Activity — list, undo the latest entry, read back; edit + delete a transaction from the register
import { open } from './lib.mjs';
const member = process.argv[2] || 'Ravi';
const s = await open(member);
const { page } = s;
const settle = async () => { await page.waitForTimeout(300); await page.waitForLoadState('networkidle'); await page.waitForTimeout(1200); };
const notices = async () => (await page.$$eval('main [role=status], main .notice', es => es.map(e => e.textContent.trim().replace(/\s+/g, ' ')).filter(Boolean).filter(t => !t.includes('funded yet'))));
await s.go('/activity');
console.log((await s.txt()).slice(0, 1500));
const undo = page.locator('main form[action*="/undo"] button').first();
console.log('first undo form:', await page.locator('main form[action*="/undo"]').first().evaluate(f => f.action + ' ' + f.closest('li,tr,article,div').innerText.replace(/\s+/g, ' ').slice(0, 200)));
await undo.click();
await settle();
console.log('undo url', page.url(), '| notices', await notices());
console.log((await s.txt()).slice(0, 600));
console.log('PROBLEMS', s.problems);
await s.browser.close();
