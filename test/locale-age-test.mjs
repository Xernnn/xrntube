// Pure-Node (no browser): pull the AGE_UNITS table + parseAgeDays() straight
// out of content/content.js and check the relative-date parser against real
// YouTube "…ago" strings in ~13 languages. Guards the locale work in
// content.js from a careless edit to one of those regexes.

import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../content/content.js", import.meta.url), "utf8");
const start = src.indexOf("const AGE_UNITS = [");
const endMark = "\n  }\n"; // end of parseAgeDays
const pEnd = src.indexOf(endMark, src.indexOf("function parseAgeDays", start));
if (start < 0 || pEnd < 0) {
  console.error("FAIL: couldn't locate AGE_UNITS / parseAgeDays in content.js");
  process.exit(1);
}
const snippet = src.slice(start, pEnd + endMark.length);
// eslint-disable-next-line no-eval
const parseAgeDays = eval(`(() => { ${snippet}; return parseAgeDays; })()`);

let bad = 0;
const near = (got, want, tol, label) => {
  const okk = got != null && Math.abs(got - want) <= tol;
  console.log(`${okk ? "ok:  " : "FAIL:"} ${label} -> ${got == null ? "null" : got.toFixed(2)}d (want ~${want})`);
  if (!okk) bad++;
};

// [text, expected days, tolerance]
const cases = [
  ["3 weeks ago", 21, 0],
  ["1 year ago", 365, 0],
  ["5 months ago", 150, 0],
  ["2 days ago", 2, 0],
  ["Streamed 4 hours ago", 4 / 24, 0.01],
  ["47 minutes ago", 47 / 1440, 0.01],
  ["hace 3 semanas", 21, 0], // es
  ["hace 2 meses", 60, 0],
  ["il y a 3 semaines", 21, 0], // fr
  ["il y a 1 an", 365, 0],
  ["vor 3 Wochen", 21, 0], // de
  ["vor 5 Monaten", 150, 0],
  ["há 3 semanas", 21, 0], // pt
  ["3 settimane fa", 21, 0], // it
  ["3 weken geleden", 21, 0], // nl
  ["3 minggu yang lalu", 21, 0], // id
  ["3 tuần trước", 21, 0], // vi
  ["3 tháng trước", 90, 0],
  ["3 hafta önce", 21, 0], // tr
  ["3 недели назад", 21, 0], // ru
  ["3 週間前", 21, 0], // ja
  ["3주 전", 21, 0], // ko
  ["1 day ago", 1, 0], // "ay" (Turkish month) must NOT win here
];
for (const [t, want, tol] of cases) near(parseAgeDays(t), want, tol, JSON.stringify(t));

// Things that must NOT parse as an age.
for (const t of ["Some video title", "4K", "1.2M views", ""]) {
  const r = parseAgeDays(t);
  console.log(`${r == null ? "ok:  " : "FAIL:"} ${JSON.stringify(t)} -> ${r == null ? "null (not an age)" : r}`);
  if (r != null) bad++;
}

console.log(bad ? `\n${bad} FAILED` : "\nDONE");
process.exit(bad ? 1 : 0);
