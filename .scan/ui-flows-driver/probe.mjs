// node probe.mjs Member /path ... : prints main text and problems for each path
import { open } from './lib.mjs';
const [member, ...paths] = process.argv.slice(2);
const s = await open(member);
for (const p of paths) { await s.go(p); console.log('=== ' + p + ' -> ' + s.page.url()); console.log((await s.txt()).slice(0, +process.env.N || 3000)); }
console.log('PROBLEMS', s.problems);
await s.browser.close();
