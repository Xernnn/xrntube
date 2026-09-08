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

await ctx.close();
console.log("\nDONE");
