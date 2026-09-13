import { chromium } from "playwright";

// The runaway-feed curb, and — just as important — that it stays out of the way
// of a feed that is loading normally.
//
// The bug: YouTube fetches the next page of an infinite feed while its
// continuation sentinel is in the viewport, on the assumption that what it just
// added made the page taller. Suppress every tile and the height never changes,
// so it fetches again immediately, forever. Measured on a video-only-blocked
// channel's /videos tab, sitting still and never scrolling: 22 continuation
// requests in 30s (0 with the extension off), 221k nodes added, 77% CPU, and
// long tasks up to 1.5s — the machine stops responding to typing.
//
// The regression this guards against is over-correction: curbing a feed that
// merely hasn't filled yet would break normal scrolling everywhere.

const EXT_PATH = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const HANDLE = "@mkbhd";

const ctx = await chromium.launchPersistentContext(`/tmp/bt-test-${process.pid}-${Math.random().toString(36).slice(2)}`, {
  headless: false,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox"],
  viewport: { width: 1500, height: 1000 }
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
const send = (m) => ext.evaluate((mm) => new Promise((r) => chrome.runtime.sendMessage(mm, r)), m);

// Count continuation fetches over a window of sitting still, plus what the page
// ended up looking like.
const watch = async (url, secs, { scroll = false } = {}) => {
  const page = await ctx.newPage();
  let reqs = 0;
  page.on("request", (r) => {
    if (/youtubei\/v1\/(browse|search|next)/.test(r.url())) reqs++;
  });
  await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForTimeout(4000);
  reqs = 0; // ignore the initial page's own loading
  if (scroll) {
    for (let i = 0; i < 4; i++) {
      await page.mouse.wheel(0, 3000);
      await page.waitForTimeout(1200);
    }
  }
  await page.waitForTimeout(secs * 1000);
  const state = await page.evaluate(() => ({
    tiles: document.querySelectorAll("ytd-rich-item-renderer, ytd-video-renderer, yt-lockup-view-model").length,
    notice: !!document.querySelector("bt-blocked-notice"),
    nodes: document.getElementsByTagName("*").length
  }));
  await page.close();
  return { reqs, ...state };
};

// ---- 1. everything blocked: the loop must stop ----
await send({ type: "UNBLOCK_CHANNEL", id: HANDLE });
await send({ type: "BLOCK_CHANNEL", id: HANDLE, name: "MKBHD", mode: "exceptWhitelist" });
await ext.waitForTimeout(6000);

const blocked = await watch(`https://www.youtube.com/${HANDLE}/videos`, 20);
blocked.reqs === 0
  ? ok("fully-blocked feed stops fetching (0 continuation requests in 20s of sitting still)")
  : fail(`fully-blocked feed still fetching: ${blocked.reqs} continuation requests`);
blocked.notice
  ? ok("the page says why it is empty instead of just being blank")
  : fail("no notice on a fully-blocked feed — nothing gives the page height, so the loop can restart");
blocked.nodes < 8000
  ? ok(`DOM stays small (${blocked.nodes} nodes — it used to grow past 43k and keep going)`)
  : fail(`DOM still growing: ${blocked.nodes} nodes`);

// ---- 2. nothing blocked: normal infinite scroll must still work ----
await send({ type: "UNBLOCK_CHANNEL", id: HANDLE });
await ext.waitForTimeout(2000);

const normal = await watch(`https://www.youtube.com/${HANDLE}/videos`, 6, { scroll: true });
normal.reqs > 0
  ? ok(`an unblocked feed still loads more on scroll (${normal.reqs} continuation requests)`)
  : fail("scrolling an unblocked feed loaded nothing — the curb is over-reaching");
!normal.notice
  ? ok("no notice on a feed that is showing content")
  : fail("notice shown on a working feed");
normal.tiles > 10
  ? ok(`unblocked feed keeps its tiles (${normal.tiles})`)
  : fail(`unblocked feed lost its tiles: ${normal.tiles}`);

// ---- 3. a partially-blocked search must still load more ----
// One blocked channel among many results: plenty survives, so nothing should
// be curbed.
await send({ type: "BLOCK_CHANNEL", id: HANDLE, name: "MKBHD", mode: "full" });
await ext.waitForTimeout(4000);
const partial = await watch("https://www.youtube.com/results?search_query=tech+review", 6, { scroll: true });
partial.reqs > 0
  ? ok(`a partially-blocked search still loads more (${partial.reqs} continuation requests)`)
  : fail("partially-blocked search stopped loading — the curb is too aggressive");
!partial.notice
  ? ok("no notice while results are still visible")
  : fail("notice shown on a search that still has visible results");

await send({ type: "UNBLOCK_CHANNEL", id: HANDLE });
await ctx.close();
