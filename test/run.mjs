// Runs every test/*-test.mjs in a child process, in series, and reports a
// summary. Each test prints `ok:` / `FAIL:` lines and exits non-zero on any
// failure (that's the whole contract — see test/README.md).
import { readdirSync } from "fs";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const dir = dirname(fileURLToPath(import.meta.url));
const only = process.argv.slice(2); // optional: names / substrings to filter
const files = readdirSync(dir)
  .filter((f) => f.endsWith("-test.mjs"))
  .filter((f) => !only.length || only.some((o) => f.includes(o)))
  .sort();

if (!files.length) {
  console.error("no matching test files");
  process.exit(1);
}

const results = [];
for (const f of files) {
  process.stdout.write(`\n\x1b[1m=== ${f} ===\x1b[0m\n`);
  const r = spawnSync("node", [join(dir, f)], { stdio: "inherit", timeout: 5 * 60 * 1000 });
  results.push({ f, ok: r.status === 0, status: r.status, timedOut: r.error?.code === "ETIMEDOUT" });
}

console.log("\n\x1b[1m=== summary ===\x1b[0m");
let failed = 0;
for (const { f, ok, status, timedOut } of results) {
  if (ok) console.log(`  \x1b[32mPASS\x1b[0m  ${f}`);
  else {
    failed++;
    console.log(`  \x1b[31mFAIL\x1b[0m  ${f}${timedOut ? " (timed out)" : ` (exit ${status})`}`);
  }
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
