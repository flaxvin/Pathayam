// Journey: undo a single activity entry by its text; print account/budget state before and after
import { open } from './lib.mjs';
const [member = 'Ravi', match = 'Received ₹5,190'] = process.argv.slice(2);
const s = await open(member);
const { page } = s;
const settle = async () => { await page.waitForTimeout(300); await page.waitForLoadState('networkidle'); await page.waitForTimeout(1200); };
const notices = async () => (await page.$$eval('main [role=status], main .notice', es => es.map(e => e.textContent.trim().replace(/\s+/g, ' ')).filter(Boolean).filter(t => !t.includes('funded yet'))));
const state = async () => {
  await s.go('/accounts');
  const t = await s.txt();
  const pick = (n) => (t.match(new RegExp(n + '[^\\n]*\\n[^\\n]*\\n?[^\\n]*')) || [''])[0].replace(/\s+/g, ' ');
  await s.go('/');
  const b = await s.txt();
  return { hdfc: pick('HDFC Savings'), amazon: pick('Amazon Pay ICICI'), rta: b.match(/Ready to Assign\n(-?₹[\d,.]+)/)?.[1],
    water: await page.$eval('.category-row[data-category-name="Water"]', e => e.innerText.replace(/\s+/g, ' ')).catch(() => ''),
    bb: await page.$eval('.category-row[data-category-name="Broadband"]', e => e.innerText.replace(/\s+/g, ' ')).catch(() => '') };
};
console.log('BEFORE', await state());
await s.go('/activity');
const entry = page.locator('main section.card > div', { hasText: match }).first();
console.log('entry:', (await entry.innerText()).replace(/\s+/g, ' '));
await entry.locator('button:has-text("Undo")').click();
await settle();
console.log('notices', await notices());
console.log('AFTER', await state());
console.log('PROBLEMS', s.problems);
await s.browser.close();
