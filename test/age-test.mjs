import { chromium } from "playwright";

const EXT_PATH = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const CH = "@mkbhd";
const QUERY = "mkbhd"; // search results carry channel bylines + publish dates
const ctx = await chromium.launchPersistentContext(`/tmp/bt-test-${process.pid}-${Math.random().toString(36).slice(2)}`, {
  headless: false,
  args: [
    `--disable-extensions-except=${EXT_PATH}`,
    `--load-extension=${EXT_PATH}`,
    "--headless=new",
    "--no-sandbox",
  ],
});
const fail = (m) => { console.error("FAIL:", m); process.exitCode = 1; };
const ok = (m) => console.log("ok:", m);

let sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 10000 }));
const extId = sw.url().split("/")[2];
const ext = await ctx.newPage();
await ext.goto(`chrome-extension://${extId}/options/options.html`);
const send = (m) => ext.evaluate((mm) => chrome.runtime.sendMessage(mm), m);

// Count MKBHD video tiles left on a search page, and their publish ages,
// for a given age rule (0 = mode off entirely -> not blocked as video-only? no:
// exceptWhitelist with days=0 blocks ALL). We compare a huge threshold
// (nothing old enough -> all pass) against a tiny one (all old -> blocked).
async function run(days) {
  await send({ type: "BLOCK_CHANNEL", id: CH, name: "MKBHD", mode: "exceptWhitelist" });
  await send({ type: "SET_CHANNEL_AGE_RULE", id: CH, days });
  const yt = await ctx.newPage();
  await yt.goto(`https://www.youtube.com/results?search_query=${QUERY}`, { waitUntil: "domcontentloaded" });
  await yt.waitForTimeout(6000);
  const data = await yt.evaluate(() => {
    const tiles = [...document.querySelectorAll("ytd-video-renderer, yt-lockup-view-model")];
    const mine = tiles.filter((t) => t.querySelector('a[href="/@MKBHD"], a[href="/@mkbhd"], a[href*="/channel/UCBJycsmduvYEL83R_U4JriQ"]'));
    const ages = mine
      .map((t) => (t.textContent.match(/\d+\s+(?:second|minute|hour|day|week|month|year)s?\s+ago/i) || [null])[0])
      .filter(Boolean);
    return { total: tiles.length, mine: mine.length, ages };
  });
  await yt.close();
  return data;
}

const keep = await run(3650);
console.log(`   age=3650d : ${keep.mine} MKBHD tiles / ${keep.total} total   ages: ${JSON.stringify(keep.ages)}`);
const block = await run(3);
console.log(`   age=3d    : ${block.mine} MKBHD tiles / ${block.total} total   ages: ${JSON.stringify(block.ages)}`);

if (keep.mine >= 3) ok(`baseline keeps MKBHD videos in search: ${keep.mine}`);
else fail(`baseline too low (${keep.mine}) — search may not have MKBHD video tiles with a byline`);

if (block.mine < keep.mine) ok(`age=3d removes older MKBHD videos: ${block.mine} < ${keep.mine}`);
else fail(`age rule had no effect in search: ${block.mine} vs ${keep.mine}`);

const survivorsOld = block.ages.filter((s) => /week|month|year/i.test(s));
survivorsOld.length === 0
  ? ok("under age=3d, no week/month/year-old MKBHD tile survives")
  : fail("age leak: " + JSON.stringify(survivorsOld));

// ---------------------------------------------------------------------------
// The watch page. The feed half above only decides whether a *tile* survives;
// this decides whether you are allowed to WATCH, and getting it wrong throws
// you out of a video you are entitled to. It did: the page-age reader fell back
// to scanning `document.body`, whose textContent includes ~807KB of YouTube's
// inline <script> JSON, so an age of 5.1e26 days came back for every video and
// an age-ruled channel bounced *everything*.
async function watchStays(videoId, days, label) {
  await send({ type: "UNBLOCK_CHANNEL", id: CH });
  await send({ type: "BLOCK_CHANNEL", id: CH, name: "MKBHD", mode: "exceptWhitelist" });
  await send({ type: "SET_CHANNEL_AGE_RULE", id: CH, days });
  await ext.waitForTimeout(1500);
  const w = await ctx.newPage();
  await w.goto(`https://www.youtube.com/watch?v=${videoId}`, { waitUntil: "domcontentloaded" }).catch(() => {});
  await w.waitForTimeout(9000);
  const url = w.url();
  await w.close();
  console.log(`   ${label}: ${url}`);
  return url.includes("/watch");
}

// Read two ids off the channel with their ages, so neither assertion below
// depends on a hard-coded video or on what was uploaded this week.
await send({ type: "UNBLOCK_CHANNEL", id: CH }); // else our own scrub empties the grid we read
await ext.waitForTimeout(1500);
const probe = await ctx.newPage();
await probe.goto(`https://www.youtube.com/${CH}/videos`, { waitUntil: "domcontentloaded" }).catch(() => {});
await probe.waitForTimeout(6000);
const grid = await probe.evaluate(() =>
  [...document.querySelectorAll("ytd-rich-item-renderer")]
    .map((t) => {
      const a = t.querySelector('a[href*="/watch?v="]');
      const m = (t.textContent || "").match(/(\d+)\s+(hour|day|week|month|year)s?\s+ago/i);
      return a && m ? { id: new URL(a.href).searchParams.get("v"), n: +m[1], unit: m[2].toLowerCase() } : null;
    })
    .filter(Boolean)
);
await probe.close();
const DAYS = { hour: 1 / 24, day: 1, week: 7, month: 30, year: 365 };
const withAge = grid.map((v) => ({ ...v, days: v.n * DAYS[v.unit] }));
const newest = withAge[0];
const old = withAge.find((v) => v.days >= 60); // comfortably past the 30d rule below

if (!newest || !old) {
  fail(`could not read a recent + an older video off the channel (${JSON.stringify(withAge.slice(0, 3))})`);
} else {
  (await watchStays(newest.id, 365, `recent video (${newest.n} ${newest.unit} old), age=365d`))
    ? ok("a recent video on an age-ruled channel still plays")
    : fail("bounced off a recent video: the age rule is blocking everything");

  // The other direction, so the assertion above can't pass merely because the
  // rule does nothing at all.
  (await watchStays(old.id, 30, `older video (${old.n} ${old.unit} old), age=30d`))
    ? fail("a video past the age rule still played — the rule is not applied on the watch page")
    : ok("a video past the age rule is bounced, so the rule really is applied");
}

await ctx.close();
console.log("\nDONE");
