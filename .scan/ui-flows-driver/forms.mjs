// node forms.mjs Member /path [filter] : list the forms on a page with their fields
import { open } from './lib.mjs';
const [member, p, filter] = process.argv.slice(2);
const s = await open(member);
await s.go(p);
const forms = await s.page.$$eval('form', fs => fs.map((f, i) => ({
  i, action: f.getAttribute('action'), method: f.method, id: f.id,
  fields: [...f.elements].filter(e => e.name || e.tagName === 'BUTTON').map(e => {
    const lab = e.labels && e.labels[0] ? e.labels[0].textContent.trim().replace(/\s+/g, ' ').slice(0, 40) : '';
    if (e.tagName === 'SELECT') return `${e.name}<select ${lab}>[${[...e.options].slice(0, 12).map(o => o.value.slice(0, 8) + '=' + o.textContent.trim().slice(0, 25)).join(' | ')}${e.options.length > 12 ? ' ...' + e.options.length : ''}]=${e.value.slice(0, 10)}`;
    if (e.tagName === 'BUTTON') return `BUTTON(${e.name || ''}=${e.value || ''}) "${e.textContent.trim().slice(0, 30)}"`;
    return `${e.name}<${e.type} ${lab}>=${(e.type === 'checkbox' || e.type === 'radio') ? (e.checked ? 'ON:' : 'off:') + e.value : e.value.slice(0, 30)}${e.required ? '*' : ''}`;
  })
})));
for (const f of forms) {
  if (filter && !(f.action || '').includes(filter)) continue;
  console.log(`#${f.i} ${f.method} ${f.action} ${f.id}`);
  for (const x of f.fields) console.log('   ' + x);
}
console.log('PROBLEMS', s.problems);
await s.browser.close();
