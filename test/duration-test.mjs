import { chromium } from "playwright";

// The duration half of the keyword/duration filter, plus regex keywords —
// neither covered anywhere else (improve-test exercises one plain-text keyword
// and nothing else).
//
// Duration is read from the tile's badge, so this needs a real search page:
// `readDurationSec()` has to pick the time badge out of a tile that also
// carries "4K", "New", "CC" badges, and that discrimination is the whole point.

const EXT_PATH = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const SEARCH = "https://www.youtube.com/results?search_query=music";

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
const ext = await ctx.newPage();
await ext.goto(`chrome-extension://${extId}/options/options.html`);
const setKeywords = (rec) =>
  ext.evaluate((r) => new Promise((res) => chrome.storage.sync.set({ bt_keywords: r }, res)), rec);

// Tiles still on the page, with the duration each one advertises. Reading the
// badge the same way the extension does keeps the expectation honest.
const survey = async () => {
  const p = await ctx.newPage();
  await p.goto(SEARCH, { waitUntil: "domcontentloaded" }).catch(() => {});
  await p.waitForTimeout(18000); // badges hydrate late; the scrub needs a few throttled passes
  const out = await p.evaluate(() => {
    const secs = (t) => {
      const m = String(t).trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
      if (!m) return null;
      return (+(m[1] || 0)) * 3600 + +m[2] * 60 + +m[3];
    };
    const res = [];
    for (const tile of document.querySelectorAll("ytd-video-renderer, yt-lockup-view-model")) {
      const badge = [...tile.querySelectorAll("badge-shape, .badge-shape-wiz__text, #text, .ytd-thumbnail-overlay-time-status-renderer")]
        .map((b) => secs(b.textContent))
        .find((v) => v != null);
      if (badge != null) res.push(badge);
    }
    return res;
  });
  await p.close();
  return out;
};

await setKeywords({ list: [], ts: Date.now(), durMinSec: 0, durMaxSec: 0 });
await ext.waitForTimeout(800);
const base = await survey();
if (base.length < 4) {
  fail(`only ${base.length} tiles with a readable duration — can't judge the filter`);
  await ctx.close();
  process.exit();
}
ok(`baseline: ${base.length} tiles with durations (${Math.min(...base)}s–${Math.max(...base)}s)`);

// ---- "shorter than" ----
// Pick a bound that should remove a real share of the page but not all of it.
const sorted = [...base].sort((a, b) => a - b);
const minBound = sorted[Math.floor(sorted.length / 2)];
console.log(`   bound chosen from the live page: ${minBound}s (median of ${base.length})`);
await setKeywords({ list: [], ts: Date.now(), durMinSec: minBound, durMaxSec: 0 });
await ext.waitForTimeout(1000);
const afterMin = await survey();
afterMin.every((d) => d >= minBound)
  ? ok(`durMinSec=${minBound}: every surviving tile is at least that long (${afterMin.length} left of ${base.length})`)
  : fail(`shorter-than filter leaked: ${JSON.stringify(afterMin.filter((d) => d < minBound))} under ${minBound}s`);
afterMin.length < base.length
  ? ok("the shorter-than filter actually removed something")
  : fail(`nothing was removed at durMinSec=${minBound}`);

// ---- "longer than" ----
const maxBound = sorted[Math.floor(sorted.length / 2)];
await setKeywords({ list: [], ts: Date.now(), durMinSec: 0, durMaxSec: maxBound });
await ext.waitForTimeout(1000);
const afterMax = await survey();
afterMax.every((d) => d <= maxBound)
  ? ok(`durMaxSec=${maxBound}: every surviving tile is at most that long (${afterMax.length} left)`)
  : fail(`longer-than filter leaked: ${JSON.stringify(afterMax.filter((d) => d > maxBound))} over ${maxBound}s`);

// ---- off again ----
await setKeywords({ list: [], ts: Date.now(), durMinSec: 0, durMaxSec: 0 });
await ext.waitForTimeout(1000);
const restored = await survey();
restored.length >= base.length * 0.6
  ? ok(`bounds cleared -> tiles come back (${restored.length})`)
  : fail(`tiles did not return after clearing the bounds: ${restored.length} vs ${base.length}`);

// ---- regex keyword (improve-test only covers plain text) ----
const p = await ctx.newPage();
await p.goto(SEARCH, { waitUntil: "domcontentloaded" }).catch(() => {});
await p.waitForTimeout(8000);
const titles = await p.evaluate(() =>
  [...document.querySelectorAll("#video-title, a.ytLockupMetadataViewModelTitle")]
    .map((e) => (e.textContent || "").trim())
    .filter(Boolean)
);
await p.close();
const word = (titles.find((t) => /\b[a-z]{5,}\b/i.test(t)) || "").match(/\b([a-z]{5,})\b/i);
if (word) {
  const re = `^${word[1]}\\b`;
  await setKeywords({ list: [{ p: re, re: true }], ts: Date.now(), durMinSec: 0, durMaxSec: 0 });
  await ext.waitForTimeout(1000);
  const p2 = await ctx.newPage();
  await p2.goto(SEARCH, { waitUntil: "domcontentloaded" }).catch(() => {});
  await p2.waitForTimeout(9000);
  const left = await p2.evaluate(
    (rx) =>
      [...document.querySelectorAll("#video-title, a.ytLockupMetadataViewModelTitle")]
        .map((e) => (e.textContent || "").trim())
        .filter((t) => new RegExp(rx, "i").test(t)).length,
    re
  );
  await p2.close();
  left === 0
    ? ok(`regex keyword /${re}/i removed every matching title`)
    : fail(`${left} titles matching /${re}/i survived`);
} else {
  console.log("ok: (skipped) no suitable title to build a regex from");
}

// A malformed regex must not take the whole filter down with it.
await setKeywords({ list: [{ p: "(unclosed", re: true }, { p: "zzzznevermatches", re: false }], ts: Date.now(), durMinSec: 0, durMaxSec: 0 });
await ext.waitForTimeout(800);
const p3 = await ctx.newPage();
const perr = [];
p3.on("pageerror", (e) => perr.push(String(e)));
await p3.goto(SEARCH, { waitUntil: "domcontentloaded" }).catch(() => {});
await p3.waitForTimeout(7000);
const stillRenders = await p3.evaluate(() => document.querySelectorAll("ytd-video-renderer, yt-lockup-view-model").length);
await p3.close();
stillRenders > 0 && perr.length === 0
  ? ok(`an invalid regex is survivable — page still renders ${stillRenders} tiles, no script errors`)
  : fail(`invalid regex broke the page: ${stillRenders} tiles, errors: ${perr[0] || "none"}`);

await setKeywords({ list: [], ts: Date.now(), durMinSec: 0, durMaxSec: 0 });
await ctx.close();
