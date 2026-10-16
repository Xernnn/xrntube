import { chromium, devices } from "playwright";

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

// ---- 4. a search where nothing survives: counted in rounds, not pixels ----
// The curb above reads geometry, and a results page is tall on its own
// (masthead, filter chips, a channel card, a shelf) — so its sentinel can sit
// out of range while every video in each arriving batch is blocked, and each
// fetch quietly makes room for the next. `noteJudgedRound()` is what covers
// that: one judged response is one round, and three rounds with no surviving
// video stop the continuations outright. A keyword that matches every title
// is the cheapest way to make "nothing survives" true of a real search.
await send({ type: "UNBLOCK_CHANNEL", id: HANDLE });
await ext.evaluate(() =>
  chrome.storage.sync.set({ bt_keywords: { list: [{ p: ".", re: true }], ts: Date.now(), durMinSec: 0, durMaxSec: 0 } })
);
await ext.waitForTimeout(2500);

const dead = await ctx.newPage();
let deadReqs = 0;
dead.on("request", (r) => {
  if (/youtubei\/v1\/(browse|search)/.test(r.url())) deadReqs++;
});
await dead.goto("https://www.youtube.com/results?search_query=tech+news&bt-debug=1", { waitUntil: "domcontentloaded" });
await dead.waitForTimeout(6000);
for (let i = 0; i < 3; i++) {
  await dead.mouse.wheel(0, 3000);
  await dead.waitForTimeout(1000);
}
const settled = deadReqs;
await dead.waitForTimeout(15000);
const deadState = await dead.evaluate(() => {
  const note = document.querySelector("bt-blocked-notice");
  return {
    // The two brakes write different notices, which is the only way from out
    // here to tell which one stopped the page: geometry (the sentinel came
    // into range on a short page) or rounds (three responses, no survivors).
    notice: note ? (note.textContent || "").trim() : null,
    onScreen: !!note && note.getClientRects().length > 0 && !!note.closest("ytd-search"),
    sentinels: document.querySelectorAll("ytd-continuation-item-renderer").length
  };
});
await dead.close();
deadReqs === settled
  ? ok(`a search with nothing left to show stops fetching (0 more in 15s after ${settled})`)
  : fail(`fully-blocked search still fetching: ${deadReqs - settled} more requests in 15s`);
deadState.sentinels === 0
  ? ok("no continuation sentinel left for YouTube to trigger on")
  : fail(`${deadState.sentinels} continuation sentinel(s) still in the page`);
deadState.notice ? ok("the page says why it stopped") : fail("no notice on an exhausted search");
deadState.onScreen
  ? ok("…on screen, in the search page")
  : fail("the notice exists but isn't on screen in the search page: " + JSON.stringify(deadState));
// Which brake won depends on how tall YouTube happened to render the page, so
// this reports rather than asserts. The round counter's own thresholds are
// pinned offline in datalayer-test ("three responses with no surviving
// video…"), where the page's height can't decide the outcome.
console.log(
  "   (stopped by:",
  /pages of results/.test(deadState.notice || "") ? "the round counter" : "the sentinel curb",
  "—",
  JSON.stringify((deadState.notice || "").slice(0, 60)) + ")"
);

const setKeywords = (list) =>
  ext.evaluate((l) => chrome.storage.sync.set({ bt_keywords: { list: l, ts: Date.now(), durMinSec: 0, durMaxSec: 0 } }), list);
// Where the notice is, and whether anyone can see it.
const noticeState = (page, pageTag) =>
  page.evaluate((tag) => {
    const all = [...document.querySelectorAll("bt-blocked-notice")];
    const shown = all.find((n) => n.getClientRects().length > 0);
    return {
      notices: all.length,
      shown: shown ? { kind: shown.getAttribute("kind"), text: shown.textContent.trim(), inPage: !!shown.closest(tag) } : null
    };
  }, pageTag);

// ---- 5. the same search, reached from another page ----
// YouTube keeps the page you came from in the DOM, hidden. A document-wide
// querySelector found the hidden channel grid's sentinel first and put the
// notice in that page, where nobody saw it; and the per-page reset ran at
// yt-navigate-finish, after the search's first response had already used up
// its rounds, which wiped the very state the notice needed. Either way the
// search just stopped, with nothing on screen saying so.
await setKeywords([]);
await ext.waitForTimeout(1500);
const spa = await ctx.newPage();
await spa.goto(`https://www.youtube.com/${HANDLE}/videos`, { waitUntil: "domcontentloaded" });
await spa.waitForTimeout(5000);
await setKeywords([{ p: ".", re: true }]);
await spa.waitForTimeout(2000);
await spa.locator("input[name='search_query']").first().fill("tech news");
await spa.keyboard.press("Enter");
await spa.waitForURL(/results/, { timeout: 10000 });
await spa.waitForTimeout(4000);
for (let i = 0; i < 4; i++) {
  await spa.mouse.wheel(0, 3000);
  await spa.waitForTimeout(1500);
}
await spa.waitForTimeout(5000);
const spaState = await noticeState(spa, "ytd-search");
await spa.close();
spaState.shown && spaState.shown.inPage && spaState.shown.kind === "stop"
  ? ok(`a search reached from a channel page says it stopped, on screen (${JSON.stringify(spaState.shown.text.slice(0, 50))}…)`)
  : fail("search reached in-app: no notice on screen — " + JSON.stringify(spaState));

// ---- 6. a feed YouTube ends by itself, with something on it blocked ----
// Not every stop is ours: a channel's last video, a search that ran out. A
// one-video channel whose one video is blocked is the smallest such feed.
await setKeywords([{ p: "zoo", re: false }]);
await ext.waitForTimeout(1500);
const ended = await ctx.newPage();
await ended.goto("https://www.youtube.com/@jawed/videos", { waitUntil: "domcontentloaded" });
let endState = null;
for (let i = 0; i < 15 && !(endState && endState.shown); i++) {
  await ended.waitForTimeout(1000);
  endState = await noticeState(ended, "ytd-browse");
}
await ended.close();
endState.shown && endState.shown.kind === "end" && endState.shown.inPage && /Nothing more to load/.test(endState.shown.text)
  ? ok(`a feed that ended with its videos blocked says nothing more is coming (${JSON.stringify(endState.shown.text)})`)
  : fail("ended feed: " + JSON.stringify(endState));

// ---- 7. a watch page whose related videos are all blocked keeps its comments ----
// The curb read the document's first sentinel, which on a watch page is the
// comments' one. With a dozen related videos blocked the count passed, and it
// removed that sentinel too: the comments stopped at their first 20.
const setRelated = (on) =>
  ext.evaluate(
    (v) => chrome.storage.sync.get("bt_settings").then((r) => chrome.storage.sync.set({ bt_settings: { ...XrnTube.resolveSettings(r.bt_settings), removeRelated: v } })),
    on
  );
await setRelated(false);
await setKeywords([{ p: "^(?!Big Buck Bunny)", re: true }]); // every title but the video's own
await ext.waitForTimeout(1500);
const wp = await ctx.newPage();
await wp.goto("https://www.youtube.com/watch?v=aqz-KE-bpKQ", { waitUntil: "domcontentloaded" });
await wp.waitForTimeout(5000);
for (let i = 0; i < 8; i++) {
  await wp.evaluate(() => window.scrollBy(0, 1500));
  await wp.waitForTimeout(2000);
}
const watchState = await wp.evaluate(() => {
  const l = document.querySelector("ytd-comments#comments ytd-item-section-renderer#sections > #contents");
  return {
    url: location.pathname,
    threads: l ? l.querySelectorAll(":scope > ytd-comment-thread-renderer").length : 0,
    noticeInComments: !!document.querySelector("ytd-comments bt-blocked-notice")
  };
});
await wp.close();
await setRelated(true);
watchState.url === "/watch" && watchState.threads > 20 && !watchState.noticeInComments
  ? ok(`a watch page with its related videos blocked still pages in comments (${watchState.threads})`)
  : fail("comments on a watch page with related videos blocked: " + JSON.stringify(watchState));

await setKeywords([]);
await send({ type: "UNBLOCK_CHANNEL", id: HANDLE });
await ctx.close();

// ---- 8. the phone site ----
// m.youtube.com's feed list is a `lazy-list` the desktop selectors never
// named, so with the sentinel gone there was nowhere to put the notice: the
// feed stopped blank. It also fires state-navigate*, never yt-navigate-*.
const phone = await chromium.launchPersistentContext(`/tmp/bt-test-${process.pid}-${Math.random().toString(36).slice(2)}`, {
  headless: false,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox"],
  ...devices["Pixel 7"]
});
const psw = phone.serviceWorkers()[0] || (await phone.waitForEvent("serviceworker", { timeout: 15000 }));
const pext = await phone.newPage();
await pext.goto(`chrome-extension://${psw.url().split("/")[2]}/options/options.html`);
await pext.evaluate(() =>
  chrome.storage.sync.set({ bt_keywords: { list: [{ p: ".", re: true }], ts: Date.now(), durMinSec: 0, durMaxSec: 0 } })
);
await pext.waitForTimeout(2000);
const mob = await phone.newPage();
await mob.goto("https://m.youtube.com/results?search_query=tech+news", { waitUntil: "domcontentloaded" });
await mob.waitForTimeout(5000);
for (let i = 0; i < 6; i++) {
  await mob.evaluate(() => window.scrollBy(0, 2500));
  await mob.waitForTimeout(1500);
}
await mob.waitForTimeout(5000);
const mobState = await noticeState(mob, "ytm-search");
mobState.shown && mobState.shown.inPage
  ? ok(`a fully-blocked search on m.youtube.com says why it stopped (${mobState.shown.kind}: ${JSON.stringify(mobState.shown.text.slice(0, 50))}…)`)
  : fail("phone: no notice on screen for a fully-blocked search — " + JSON.stringify(mobState));
await phone.close();
