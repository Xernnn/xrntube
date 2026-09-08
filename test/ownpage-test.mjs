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
const survivors = await p2.evaluate((wl) => {
  const tiles = [...document.querySelectorAll("ytd-rich-item-renderer")].filter(
    (t) => t.isConnected && t.querySelector('a[href*="watch?v="]') && getComputedStyle(t).display !== "none"
  );
  return tiles.map((t) => {
    const m = t.querySelector('a[href*="watch?v="]').getAttribute("href").match(/[?&]v=([\w-]{11})/);
    return m ? m[1] : "?";
  });
}, wlId);
await p2.close();
console.log("   surviving tile ids:", JSON.stringify(survivors));
(survivors.length >= 1 && survivors.every((id) => id === wlId))
  ? ok(`whitelist honoured on the channel page — only ${wlId} left`)
  : fail(`whitelist not honoured: survivors ${JSON.stringify(survivors)}`);

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

await ctx.close();
console.log("\nDONE");
