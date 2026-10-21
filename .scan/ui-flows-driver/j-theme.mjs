// Journey: toggle theme from /cards via header button; check data-theme flips and URL stays
import { open } from './lib.mjs';
const s = await open(process.argv[2] || 'Anil');
const { page } = s;
await s.go('/cards');
const th = () => page.evaluate(() => document.documentElement.getAttribute('data-theme'));
console.log('before', await th(), page.url());
await page.click('header form[action="/settings/theme"] button');
await page.waitForTimeout(1500);
console.log('after 1', await th(), page.url());
await page.click('header form[action="/settings/theme"] button');
await page.waitForTimeout(1500);
console.log('after 2', await th(), page.url());
await page.reload();
console.log('after reload', await th());
console.log('PROBLEMS', s.problems);
await s.browser.close();
