import { chromium } from "playwright";

// The options-page subscriber-count workflow:
//   - biggest-first is the default sort;
//   - lists are growable, not truncated (a capped list you can't page through
//     means the rest of the blocklist is simply unreachable);
//   - the "No sub count" tab collects channels with no usable number;
//   - opening the page fetches counts for channels never looked up, and
//     pushes them to the gist;
//   - a count once cached is never re-fetched.
//
// Mostly synthetic data; three real channels are used for the one assertion
// that needs a live scrape.

const EXT_PATH = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const REAL = ["@mkbhd", "@LinusTechTips", "@veritasium"];
const SYNTH = 700;

const ctx = await chromium.launchPersistentContext(`/tmp/bt-test-${process.pid}-${Math.random().toString(36).slice(2)}`, {
  headless: false,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox"],
  viewport: { width: 1400, height: 1000 }
});
const fail = (m) => {
  console.error("FAIL:", m);
  process.exitCode = 1;
};
const ok = (m) => console.log("ok:", m);

const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 15000 }));
const extId = sw.url().split("/")[2];
const optionsUrl = `chrome-extension://${extId}/options/options.html`;

// Which scrape generation counts as "already fetched". A count recorded by an
// older scrape is deliberately NOT an attempt (see subsAttempted), so a seed
// that omits this reads as a blocklist that has never been swept.
const probe = await ctx.newPage();
await probe.goto(optionsUrl);
const SUBS_V = await probe.evaluate(() => self.BlockTube.SUBS_SCRAPE_VERSION);
await probe.close();

// Seed: synthetic channels that already carry a count (so the auto-fetch has
// no reason to touch them), two whose count is genuinely unavailable, and the
// real ones with nothing — those are what the auto-fetch should resolve.
const seed = { channels: {} };
for (let i = 0; i < SYNTH; i++) {
  seed.channels["UC" + String(i).padStart(22, "x")] = {
    name: "Synthetic " + i,
    ts: Date.now() - i * 1000,
    subs: `${((i * 9161) % SYNTH) + 1}K`,
    subsAt: Date.now(),
    subsV: SUBS_V
  };
}
for (const [id, subs] of [["UChiddenAAAAAAAAAAAAAAA", "hidden"], ["UCnaBBBBBBBBBBBBBBBBBBB", "n/a"]]) {
  seed.channels[id] = { name: "Unavailable", ts: Date.now(), subs, subsAt: Date.now(), subsV: SUBS_V };
}
for (const h of REAL) seed.channels[h] = { name: h, ts: Date.now() };
const TOTAL = SYNTH + 2 + REAL.length;

const boot = await ctx.newPage();
await boot.goto(optionsUrl);
await boot.evaluate(
  (s) => new Promise((r) => chrome.runtime.sendMessage({ type: "IMPORT_BLOCKLIST", channels: s.channels, videos: {} }, r)),
  seed
);
await boot.waitForTimeout(1500);
await boot.close();

// Reopening is the run under test — the auto-fetch fires on open.
const p = await ctx.newPage();
await p.goto(optionsUrl);
await p.waitForTimeout(2500);

(await p.$eval("#sort-by", (e) => e.value)) === "subsDesc"
  ? ok("sort defaults to subscribers high → low")
  : fail(`default sort is "${await p.$eval("#sort-by", (e) => e.value)}", expected subsDesc`);

// Rows must actually be in descending order — "21.2M" sorts above "700K", so
// the comparison has to respect the K/M/B suffix.
const toNum = (t) => {
  const m = String(t).match(/^([\d.]+)\s*([KMB])?/i);
  return m ? parseFloat(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[(m[2] || "").toLowerCase()] || 1) : null;
};
const chips = (await p.$$eval("#channel-list .subs-chip", (els) => els.slice(0, 8).map((e) => e.textContent)))
  .map(toNum)
  .filter((n) => n != null);
chips.length >= 3 && chips.every((n, i) => i === 0 || chips[i - 1] >= n)
  ? ok(`channel list is sorted biggest-first (${chips.slice(0, 3).join(" ≥ ")})`)
  : fail(`rows are not in descending sub order: ${chips.join(", ")}`);

// The whole list must be reachable, not just the first page of it.
const capped = await p.$$eval("#channel-list .channel-row", (els) => els.length);
await p.$$eval("#channel-more button", (bs) => bs[bs.length - 1].click()); // "Show all"
await p.waitForTimeout(2500);
const shownAll = await p.$$eval("#channel-list .channel-row", (els) => els.length);
capped === 300 && shownAll === TOTAL
  ? ok(`"Show all" grows the list past the render cap (${capped} → ${shownAll})`)
  : fail(`expected 300 rows then ${TOTAL}, got ${capped} then ${shownAll}`);

// Let the auto-fetch settle before judging what still lacks a count.
await p.waitForTimeout(20000);

const after = await p.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ type: "GET_BLOCKLIST" }, r)));
const missing = REAL.filter((h) => !(after.channels[h] || {}).subs);
missing.length === 0
  ? ok(`opening the page auto-fetched the missing counts (${REAL.map((h) => after.channels[h].subs).join(", ")})`)
  : fail(`auto-fetch left ${missing.join(", ")} without a subscriber count`);

await p.selectOption("#filter-by", "nosubs");
await p.waitForTimeout(800);
const noSubRows = await p.$$eval("#channel-list .channel-row", (els) => els.length);
const allLackNumbers = await p.$$eval("#channel-list .channel-row", (els) =>
  els.every((li) => !/\d/.test(li.querySelector(".subs-chip")?.textContent || ""))
);
noSubRows === 2 && allLackNumbers
  ? ok('"No sub count" tab holds exactly the channels with no usable number')
  : fail(`"No sub count" tab shows ${noSubRows} rows (expected 2), allLackNumbers=${allLackNumbers}`);

// A cached count is permanent: reopening must not start another sweep.
const p2 = await ctx.newPage();
await p2.goto(optionsUrl);
await p2.waitForTimeout(4000);
const progressHidden = await p2.$eval("#bulk-progress", (e) => e.hidden);
const fetchBtnHidden = await p2.$eval("#fetch-all-subs-btn", (e) => e.hidden);
progressHidden && fetchBtnHidden
  ? ok("reopening re-fetches nothing — cached counts are reused as-is")
  : fail(`a fetch started on reopen (progress hidden=${progressHidden}, button hidden=${fetchBtnHidden})`);

await ctx.close();
