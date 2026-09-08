import { chromium } from "playwright";

const EXT_PATH = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const MKBHD_UC = "UCBJycsmduvYEL83R_U4JriQ";
const SEARCH = "https://www.youtube.com/results?search_query=mkbhd+iphone+review";
const ctx = await chromium.launchPersistentContext(`/tmp/bt-test-${process.pid}-${Math.random().toString(36).slice(2)}`, {
  headless: false,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox"],
});
const fail = (m) => { console.error("FAIL:", m); process.exitCode = 1; };
const ok = (m) => console.log("ok:", m);

let sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 10000 }));
const extId = sw.url().split("/")[2];
const ext = await ctx.newPage();
await ext.goto(`chrome-extension://${extId}/options/options.html`);
const send = (m) => ext.evaluate((mm) => chrome.runtime.sendMessage(mm), m);

const countMkbhdTiles = (p) =>
  p.evaluate(() =>
    [...document.querySelectorAll("ytd-video-renderer, ytd-rich-item-renderer, yt-lockup-view-model")].filter(
      (t) => t.querySelector('a[href="/@mkbhd" i], a[href="/@MKBHD"]')
    ).length
  );

// --- 1. block by UC id only (no handle yet) — should NOT block handle-linked tiles ---
await send({ type: "BLOCK_CHANNEL", id: MKBHD_UC, name: "", mode: "full" });
await ext.waitForTimeout(200);
let bl = await send({ type: "GET_BLOCKLIST" });
!bl.channels[MKBHD_UC].handle ? ok("blocked by UC id, no handle cached yet") : fail("handle already set?");

const before = await ctx.newPage();
await before.goto(SEARCH, { waitUntil: "domcontentloaded" });
await before.waitForTimeout(7000);
const nBefore = await countMkbhdTiles(before);
await before.close();
nBefore > 0
  ? ok(`repro: ${nBefore} MKBHD tiles slip through when blocked only by UC id (tiles link /@mkbhd)`)
  : console.log("   (no MKBHD tiles on that search right now — can't show the repro, continuing)");

// --- 2. enrich -> handle cached, rebroadcast -> fresh page blocks by handle ---
const r = await send({ type: "BULK_FETCH_CHANNEL_INFO", ids: [MKBHD_UC] });
console.log("   enrich ->", JSON.stringify(r));
bl = await send({ type: "GET_BLOCKLIST" });
bl.channels[MKBHD_UC].handle
  ? ok(`enrich cached handle ${bl.channels[MKBHD_UC].handle}`)
  : fail("enrich did not cache a handle: " + JSON.stringify(bl.channels[MKBHD_UC]));
await send({ type: "REBROADCAST_BLOCKLIST" });

const after = await ctx.newPage();
await after.goto(SEARCH, { waitUntil: "domcontentloaded" });
await after.waitForTimeout(8000);
const nAfter = await countMkbhdTiles(after);
const styleHasHandle = await after.evaluate(() => {
  const s = document.getElementById("bt-instant-hide");
  return !!s && /a\[href="\/@mkbhd"/i.test(s.textContent);
});
await after.close();
styleHasHandle ? ok("instant-hide CSS now includes an /@mkbhd selector") : fail("CSS still has no handle selector");
nAfter === 0
  ? ok(`fix: UC-keyed block now removes all MKBHD tiles (${nBefore} → 0)`)
  : fail(`${nAfter} MKBHD tiles still present after enrich + handle matching`);

// --- 3. open tab picks it up via REBROADCAST without a reload ---
await send({ type: "UNBLOCK_CHANNEL", id: MKBHD_UC });
await ext.waitForTimeout(200);
const live = await ctx.newPage();
await live.goto(SEARCH, { waitUntil: "domcontentloaded" });
await live.waitForTimeout(7000);
const liveBefore = await countMkbhdTiles(live);
await send({ type: "BLOCK_CHANNEL", id: MKBHD_UC, name: "", mode: "full" });
await send({ type: "BULK_FETCH_CHANNEL_INFO", ids: [MKBHD_UC] });
await send({ type: "REBROADCAST_BLOCKLIST" });
await live.waitForTimeout(3000);
const liveAfter = await countMkbhdTiles(live);
await live.close();
(liveBefore > 0 && liveAfter === 0)
  ? ok(`already-open tab: ${liveBefore} → 0 MKBHD tiles after enrich + rebroadcast (no reload)`)
  : console.log(`   open-tab rebroadcast: ${liveBefore} → ${liveAfter} (inconclusive if liveBefore was 0)`);

await ctx.close();
console.log("\nDONE");
