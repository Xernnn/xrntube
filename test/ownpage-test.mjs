import { chromium } from "playwright";

const EXT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const CH = "@mkbhd";
const VIDEOS_URL = `https://www.youtube.com/${CH}/videos`;
const ctx = await chromium.launchPersistentContext(`/tmp/bt-test-${process.pid}-${Math.random().toString(36).slice(2)}`, {
  headless: false,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--headless=new", "--no-sandbox"],
});
const fail = (m) => { console.error("FAIL:", m); process.exitCode = 1; };
const ok = (m) => console.log("ok:", m);

let sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 10000 }));
const extId = sw.url().split("/")[2];
const ext = await ctx.newPage();
await ext.goto(`chrome-extension://${extId}/options/options.html`);
const send = (m) => ext.evaluate((mm) => chrome.runtime.sendMessage(mm), m);

const countVideoTiles = (p) =>
  p.evaluate(() =>
    [...document.querySelectorAll("ytd-rich-item-renderer, ytd-grid-video-renderer")].filter(
      (t) => t.isConnected && t.querySelector('a[href*="watch?v="]') && getComputedStyle(t).display !== "none"
    ).length
  );

// baseline + grab a real video id for the whitelist test
const base = await ctx.newPage();
await base.goto(VIDEOS_URL, { waitUntil: "domcontentloaded" });
await base.waitForTimeout(7000);
const nBase = await countVideoTiles(base);
const wlId = await base.evaluate(() => {
  const a = document.querySelector('ytd-rich-item-renderer a[href*="watch?v="]');
  const m = a && a.getAttribute("href").match(/[?&]v=([\w-]{11})/);
  return m ? m[1] : null;
});
await base.close();
nBase >= 5 ? ok(`baseline: ${nBase} video tiles on ${CH}/videos`) : fail(`baseline too low: ${nBase}`);
wlId ? ok(`grabbed a real video id for the whitelist test: ${wlId}`) : fail("no video id found");

// ---- block-all-videos, no whitelist -> the /videos tab is emptied ----
await send({ type: "BLOCK_CHANNEL", id: CH, name: "MKBHD", mode: "exceptWhitelist" });
await send({ type: "BULK_FETCH_CHANNEL_INFO", ids: [CH] }); // (not needed for @handle key, harmless)
await send({ type: "REBROADCAST_BLOCKLIST" });
const p1 = await ctx.newPage();
await p1.goto(VIDEOS_URL, { waitUntil: "domcontentloaded" });
await p1.waitForTimeout(8000);
const n1 = await countVideoTiles(p1);
const styleOn = await p1.evaluate(() => {
  const s = document.getElementById("bt-channel-page-hide");
  return !!s && /page-subtype="channels"/.test(s.textContent || "");
});
await p1.close();
styleOn ? ok("pre-paint CSS rule injected for the channel page") : console.log("   (no page-subtype attr; JS-only)");
n1 === 0 ? ok(`block-all-videos: ${nBase} → 0 tiles on the channel's Videos tab`) : fail(`${n1} video tiles still shown`);

// ---- whitelist one video -> exactly that one survives ----
await send({ type: "WHITELIST_CHANNEL_VIDEO", id: CH, videoId: wlId, title: "kept" });
await send({ type: "REBROADCAST_BLOCKLIST" });
const p2 = await ctx.newPage();
await p2.goto(VIDEOS_URL, { waitUntil: "domcontentloaded" });
await p2.waitForTimeout(8000);
const survivors = await p2.evaluate(() => {
  const tiles = [...document.querySelectorAll("ytd-rich-item-renderer")].filter(
    (t) => t.isConnected && t.querySelector('a[href*="watch?v="]') && getComputedStyle(t).display !== "none"
  );
  return tiles.map((t) => {
    const m = t.querySelector('a[href*="watch?v="]').getAttribute("href").match(/[?&]v=([\w-]{11})/);
    return m ? m[1] : "?";
  });
});
await p2.close();
console.log("   surviving tile ids:", JSON.stringify(survivors));
(survivors.length >= 1 && survivors.every((id) => id === wlId))
  ? ok(`whitelist honoured on the channel page — only ${wlId} left`)
  : fail(`whitelist not honoured: survivors ${JSON.stringify(survivors)}`);

// ---- the same page reached by a legacy /c/<name> URL ----
// /c/… and /user/… name NEITHER identity format, so the page's own path
// yields no channel key at all. This function used to key off the path alone
// and so did nothing here: a FULL block was still saved by the nav guard's
// bounce, but a video-only block (this one) left the entire grid on display.
// The page's canonical metadata is what resolves it — the same
// pageIdentityKeys() the nav guard already uses. Confirmed live that
// /c/mkbhd/videos serves 200 directly rather than server-redirecting to
// /@MKBHD, so this really does exercise the legacy path.
const pLegacy = await ctx.newPage();
await pLegacy.goto("https://www.youtube.com/c/mkbhd/videos", { waitUntil: "domcontentloaded" });
await pLegacy.waitForTimeout(8000);
const legacySurvivors = await pLegacy.evaluate(() =>
  [...document.querySelectorAll("ytd-rich-item-renderer, ytd-grid-video-renderer")]
    .filter((t) => t.isConnected && t.querySelector('a[href*="watch?v="]') && getComputedStyle(t).display !== "none")
    .map((t) => {
      const m = t.querySelector('a[href*="watch?v="]').getAttribute("href").match(/[?&]v=([\w-]{11})/);
      return m ? m[1] : "?";
    })
);
await pLegacy.close();
console.log("   surviving tile ids on /c/mkbhd/videos:", JSON.stringify(legacySurvivors));
legacySurvivors.every((id) => id === wlId)
  ? ok(`legacy /c/<name> URL resolves to the blocked channel (${legacySurvivors.length} tile(s) left, whitelist only)`)
  : fail(`legacy /c/<name> URL left ${legacySurvivors.length} tiles: ${JSON.stringify(legacySurvivors)}`);

// ---- navigating away clears the channel-page CSS ----
const p3 = await ctx.newPage();
await p3.goto("https://www.youtube.com/feed/subscriptions", { waitUntil: "domcontentloaded" });
await p3.waitForTimeout(5000);
const styleCleared = await p3.evaluate(() => {
  const s = document.getElementById("bt-channel-page-hide");
  return !s || !s.textContent.trim();
});
await p3.close();
styleCleared ? ok("channel-page CSS is empty when not on a blocked channel page") : fail("stale channel-page CSS on the feed");

// ---- an age rule has to reach the channel's Shorts tab ----
// A Shorts tile carries no publish date anywhere — the DOM shows a title and
// a view count, and `shortsLockupViewModel` in the JSON has no date field at
// all. Read as "unknown age means recent", that exempted every short the
// channel has: measured live on an age-ruled channel, the Videos tab went to
// 2 tiles while the Shorts tab kept all 50.
//
// The Shorts toggle is turned OFF for this, or its blanket removal would
// empty the tab whatever the age rule did and the assertion would pass
// without testing anything.
await ext.evaluate(() => chrome.storage.sync.set({ bt_settings: { shortsFeedTiles: false } }));
await send({ type: "UNBLOCK_CHANNEL", id: CH });
await ext.waitForTimeout(2500);

const countShorts = (p) =>
  p.evaluate(() =>
    [...document.querySelectorAll("ytm-shorts-lockup-view-model-v2, ytm-shorts-lockup-view-model")].filter(
      (t) => t.isConnected && getComputedStyle(t).display !== "none"
    ).length
  );

const pShortsBase = await ctx.newPage();
await pShortsBase.goto(`https://www.youtube.com/${CH}/shorts`, { waitUntil: "domcontentloaded" });
await pShortsBase.waitForTimeout(8000);
const shortsBase = await countShorts(pShortsBase);
await pShortsBase.close();
shortsBase > 5
  ? ok(`baseline: ${shortsBase} Shorts on ${CH}/shorts with the Shorts toggle off`)
  : fail(`baseline too low to test against: ${shortsBase} Shorts tiles`);

await send({ type: "BLOCK_CHANNEL", id: CH, name: "MKBHD", mode: "exceptWhitelist" });
await ext.waitForTimeout(4000);
await send({ type: "SET_CHANNEL_AGE_RULE", id: CH, days: 2 });
await send({ type: "REBROADCAST_BLOCKLIST" });
await ext.waitForTimeout(1000);

const pShorts = await ctx.newPage();
await pShorts.goto(`https://www.youtube.com/${CH}/shorts`, { waitUntil: "domcontentloaded" });
await pShorts.waitForTimeout(9000);
const shortsLeft = await countShorts(pShorts);
const emptyWrappers = await pShorts.evaluate(
  () =>
    [...document.querySelectorAll("ytd-rich-item-renderer")].filter((w) => w.isConnected && !w.firstElementChild).length
);
await pShorts.close();
shortsLeft === 0
  ? ok(`age rule reaches Shorts: ${shortsBase} → 0 on the channel's Shorts tab`)
  : fail(`${shortsLeft} Shorts still on an age-ruled channel's own tab`);
emptyWrappers === 0
  ? ok("…and no empty grid wrappers are left standing where they were")
  : fail(`${emptyWrappers} empty ytd-rich-item-renderer wrappers left behind`);

await send({ type: "UNBLOCK_CHANNEL", id: CH });
await ctx.close();
console.log("\nDONE");
