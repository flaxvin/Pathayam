// Journey: undo a remaining leg of an already-reversed transfer and watch account balances
import { open } from './lib.mjs';
const [member = 'Ravi', match = 'Spent ₹5,190'] = process.argv.slice(2);
const s = await open(member);
const { page } = s;
const settle = async () => { await page.waitForTimeout(300); await page.waitForLoadState('networkidle'); await page.waitForTimeout(1200); };
const bal = async () => { await s.go('/accounts'); const t = await s.txt();
  const g = (n) => t.split(n)[1]?.match(/\n(-?₹[\d,.]+)\n/)?.[1]; return { hdfc: g('HDFC Savings'), amazon: g('Amazon Pay ICICI') }; };
console.log('BEFORE', await bal());
await s.go('/activity');
const entry = page.locator('main section.card > div', { hasText: match }).first();
console.log('entry:', (await entry.innerText()).replace(/\s+/g, ' '));
await entry.locator('button:has-text("Undo")').click();
await settle();
console.log('notices', await page.$$eval('main [role=status]', es => es.map(e => e.textContent.trim())));
console.log('AFTER', await bal());
await page.screenshot({ path: '/home/user/Pathayam/.claude/worktrees/agent-a004523ed47003c7f/.scratch/undo-leg.png' });
console.log('PROBLEMS', s.problems);
await s.browser.close();
