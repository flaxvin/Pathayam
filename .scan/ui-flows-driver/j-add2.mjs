// Journey: on /add, typing a known payee should fill its usual envelope; a cross-budget pairing should be explained
import { open } from './lib.mjs';
const member = process.argv[2] || 'Ravi';
const s = await open(member);
const { page } = s;
await s.go('/add');
const known = await page.$$eval('#payee-options option[data-category]', os => os.slice(0, 3).map(o => [o.value, o.getAttribute('data-category')]));
console.log('known payees with usual envelope', known);
await page.click('#payee');
await page.keyboard.type(known[0][0]);
await page.click('#amount'); // blur payee
await page.waitForTimeout(200);
const v = await page.$eval('#split_category_0', e => e.value + ' / ' + e.options[e.selectedIndex].textContent.trim());
console.log('envelope after picking payee:', v, '(expected id', known[0][1], ')');
console.log('cross-budget note present:', await page.$('[data-cross-budget]') !== null);
const optsBudget = await page.$$eval('#split_category_0 option', os => os.filter(o => o.getAttribute('data-budget')).length);
console.log('envelope options carrying data-budget:', optsBudget);
console.log('optgroups in envelope list:', await page.$$eval('#split_category_0 optgroup', g => g.map(x => x.label)));
await page.screenshot({ path: '/home/user/Pathayam/.scan/screens/ui-flows/add-usual-envelope-not-filled.png', clip: { x: 220, y: 90, width: 1060, height: 600 } });
console.log('PROBLEMS', s.problems);
await s.browser.close();
