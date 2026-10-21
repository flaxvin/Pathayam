import { readFileSync } from "node:fs";
const data = JSON.parse(readFileSync(process.argv[2]));
const keys = (process.argv[3] ?? "overflow,tap,contrast,labels,dupIds,headings,fmt,console,failed").split(",");
const agg = {};
for (const [k, r] of Object.entries(data)) {
  if (r.error) { console.log("ERR", k, r.error.slice(0, 100)); continue; }
  if (r.status >= 400) console.log("STATUS", r.status, k);
  if (r.docScroll > 0) console.log("DOCSCROLL", r.docScroll, k);
  if (r.cls > 0.05) console.log("CLS", r.cls.toFixed(3), k);
  if (r.timing.server > 500) console.log("SLOW", r.timing.server, "ms", k, r.bytes);
  for (const key of keys) for (const v of r[key] ?? []) { const id = key + " | " + v.replace(/ \d+x\d+$/, "").replace(/«[^»]*»/, "«»").replace(/\[-?\d+\.\.\d+\]/, ""); (agg[id] ??= []).push(k.split(" ").slice(1).join(" ") + " [" + v + "]"); }
}
for (const [id, where] of Object.entries(agg).sort((a, b) => b[1].length - a[1].length)) console.log(where.length, id, "::", where.slice(0, 3).join(" ; "));
