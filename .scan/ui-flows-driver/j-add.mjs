// Journey: add an expense from /add, read back; check client behaviours survive the in-place swap
import { open } from './lib.mjs';
const member = process.argv[2] || 'Ravi';
const s = await open(member);
const { page } = s;
const settle = async () => { await page.waitForTimeout(300); await page.waitForLoadState('networkidle'); await page.waitForTimeout(1500); };
await s.go('/add');
const pickAcct = async (name) => {
  const v = await page.$$eval('#account_id option', (os, n) => os.find(o => o.textContent.includes(n))?.value, name);
  await page.selectOption('#account_id', v);
};
const accts = await page.$$eval('#account_id option', os => os.map(o => [o.textContent.trim(), o.getAttribute('data-budget')?.slice(0, 8)]));
console.log('accounts', JSON.stringify(accts));
const personal = accts.find(a => !a[1].startsWith('budget-h'));
const spender = () => page.$eval('[data-spender]', s => s.options[s.selectedIndex].textContent.trim()).catch(e => 'n/a');
const note = () => page.$eval('[data-cross-budget]', e => e.hidden ? '(hidden)' : e.textContent);
if (personal) {
  await pickAcct(personal[0]);
  await page.selectOption('#split_category_0', { index: 3 });
  console.log('cross-budget note with', personal[0], '->', await note());
}
await pickAcct('HDFC Savings');
await page.fill('#amount', '123.45');
await page.fill('#payee', 'UI Audit Shop');
await page.selectOption('#split_category_0', { index: 6 });
const env = await page.$eval('#split_category_0', e => e.options[e.selectedIndex].textContent.trim());
await page.click('main form[action="/add"] button[type=submit]');
await settle();
console.log('URL after save', page.url(), 'envelope was', env);
console.log('notices', await page.$$eval('[role=status]', es => es.map(e => e.textContent.trim()).filter(Boolean)));
if (page.url().includes('/add')) {
  await pickAcct('Amazon Pay ICICI');
  console.log('after swap: Amazon Pay -> spender', await spender());
  if (personal) { await pickAcct(personal[0]); await page.selectOption('#split_category_0', { index: 3 }); console.log('after swap cross-budget note ->', await note()); }
  await page.selectOption('#direction', 'in');
  console.log('blank option after direction=in', await page.$eval('#split_category_0 option[value=""]', e => e.textContent));
}
console.log('PROBLEMS', s.problems);
await s.browser.close();
