import { open } from './lib.mjs';
const [member, p, name, full] = process.argv.slice(2);
const s = await open(member);
await s.go(p);
await s.page.screenshot({ path: '/home/user/Pathayam/.claude/worktrees/agent-a004523ed47003c7f/.scratch/' + name + '.png', fullPage: !!full });
console.log('PROBLEMS', s.problems);
await s.browser.close();
