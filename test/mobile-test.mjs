import { chromium, devices } from "playwright";

// m.youtube.com, as a phone browser (Quetta, Kiwi…) loads it: a phone's user
// agent, viewport and touch, no hover. Covers what the desktop suite can't:
//   - a blocked channel's videos leave mobile search, its page redirects
//   - the popup's target on a mobile watch page names the channel and title
//   - the block rows sit in YouTube's own ⋮ sheet, and tapping one blocks
//   - the related videos, the video's action row and the bottom bar follow
//     the same switches as on the desktop
//   - tapping the logo goes to Subscriptions without a reload

const EXT_PATH = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const phone = devices["Pixel 7"];
const ctx = await chromium.launchPersistentContext(`/tmp/bt-test-${process.pid}-${Math.random().toString(36).slice(2)}`, {
  headless: false,
  userAgent: phone.userAgent,
  viewport: phone.viewport,
  deviceScaleFactor: phone.deviceScaleFactor,
  isMobile: true,
  hasTouch: true,
  locale: "en-US",
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox"]
});
const fail = (m) => {
  console.error("FAIL:", m);
  process.exitCode = 1;
};
const ok = (m) => console.log("ok:", m);

const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 15000 }));
const opt = await ctx.newPage();
await opt.goto(`chrome-extension://${sw.url().split("/")[2]}/options/options.html`);
const send = (m) => opt.evaluate((mm) => chrome.runtime.sendMessage(mm), m);
const p = await ctx.newPage();
const errs = [];
p.on("pageerror", (e) => errs.push(e.message));

const TILE_SEL = "ytm-video-with-context-renderer, ytm-compact-video-renderer, ytm-media-item, ytm-rich-item-renderer";
// By the channel a tile links, not by its text: other channels' videos about
// MKBHD ("iShowSpeed Meets Marques Brownlee…") rightly stay, and counting
// those failed this whenever search served one.
const mkbhdTiles = () =>
  p.evaluate((sel) => {
    const vis = (e) => !!(e.offsetWidth || e.offsetHeight) && getComputedStyle(e).display !== "none";
    const tiles = [...document.querySelectorAll(sel)].filter(vis);
    const link = 'a[href="/@mkbhd"], a[href^="/@mkbhd/"], a[href*="/channel/UCBJycsmduvYEL83R_U4JriQ"]';
    return { all: tiles.length, mkbhd: tiles.filter((t) => t.querySelector(link)).length };
  }, TILE_SEL);

// ---- 1. blocking on mobile search, and the channel page ----
await p.goto("https://m.youtube.com/results?search_query=mkbhd", { waitUntil: "domcontentloaded" });
await p.waitForTimeout(7000);
const before = await mkbhdTiles();
await send({
  type: "IMPORT_BLOCKLIST",
  channels: { "@mkbhd": { name: "MKBHD", mode: "full", ucid: "UCBJycsmduvYEL83R_U4JriQ", subsAt: Date.now(), subsV: 9 } },
  videos: {}
});
await p.goto("https://m.youtube.com/results?search_query=mkbhd", { waitUntil: "domcontentloaded" });
await p.waitForTimeout(7000);
const after = await mkbhdTiles();
before.mkbhd >= 3 && after.mkbhd === 0
  ? ok(`mobile search: ${before.mkbhd} MKBHD tiles → ${after.mkbhd} once blocked`)
  : fail(`mobile search: before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
await p.goto("https://m.youtube.com/@mkbhd", { waitUntil: "domcontentloaded" });
await p.waitForTimeout(5000);
/\/feed\/subscriptions/.test(p.url())
  ? ok("a blocked channel's mobile page redirects to Subscriptions")
  : fail("mobile channel page not redirected: " + p.url());
await send({ type: "UNBLOCK_CHANNEL", id: "@mkbhd" });

// ---- 2. what the popup sees on a mobile watch page ----
await p.goto("https://m.youtube.com/watch?v=adQyLViK_ZU", { waitUntil: "domcontentloaded" });
await p.waitForTimeout(8000);
const target = await opt.evaluate(async () => {
  const [tab] = await chrome.tabs.query({ url: "*://m.youtube.com/watch*" });
  return chrome.tabs.sendMessage(tab.id, { type: "GET_PAGE_TARGET" });
});
target.videoId === "adQyLViK_ZU" && target.videoTitle && target.videoTitle !== "YouTube" && target.channels.length === 1
  ? ok(`popup target on a mobile watch page: "${target.videoTitle.slice(0, 40)}…" by ${target.channels[0].key}`)
  : fail("mobile popup target: " + JSON.stringify(target));

// ---- 3. XrnTube's rows live in YouTube's ⋮ sheet, once ----
// There is no button of ours on a tile any more: a tap on YouTube's own ⋮
// adds the block rows to the bottom sheet it opens. A channel's Videos tab
// is a rich grid, every cell `ytm-rich-item-renderer > ytm-compact-video-
// renderer` (both tiles), which once got two XrnTube menus per video.
const tapMenu = async (nth) => {
  const found = await p.evaluate((n) => {
    document.querySelectorAll("[data-bt-test]").forEach((e) => e.removeAttribute("data-bt-test"));
    const tiles = "ytm-video-with-context-renderer, ytm-rich-item-renderer, yt-lockup-view-model, ytm-compact-video-renderer";
    const b = [...document.querySelectorAll("ytm-bottom-sheet-renderer button, .ytLockupMetadataViewModelMenuButton button")].filter(
      (x) => x.closest(tiles) && x.getBoundingClientRect().top > 120
    )[n];
    if (!b) return false;
    b.scrollIntoView({ block: "center" });
    b.setAttribute("data-bt-test", "menu");
    b.closest(tiles).setAttribute("data-bt-test", "tile");
    return true;
  }, nth);
  if (!found) return null;
  await p.waitForTimeout(400);
  await p.tap('[data-bt-test="menu"]');
  await p.waitForTimeout(1500);
  return p.evaluate(() => {
    const shown = [...document.querySelectorAll("bt-tile-menu")].filter((s) => s.getClientRects().length);
    const rows = shown.flatMap((s) =>
      [...s.querySelectorAll(".bt-menu-row")].map((r) => {
        const b = r.getBoundingClientRect();
        const hit = document.elementFromPoint(b.left + 30, b.top + b.height / 2);
        return { text: r.querySelector(".bt-menu-text").firstChild.textContent, reachable: !!hit && r.contains(hit) };
      })
    );
    return { menus: shown.length, inSheet: shown.every((s) => !!s.closest("bottom-sheet-container")), rows };
  });
};
const closeSheet = () => p.evaluate(() => document.querySelector("bottom-sheet-container button.close-button, bottom-sheet-container ytw-scrim button")?.click());

await p.goto("https://m.youtube.com/@veritasium/videos", { waitUntil: "domcontentloaded" });
await p.waitForTimeout(7000);
const oldButtons = await p.evaluate(() => document.querySelectorAll(".bt-block-btn, .bt-block-menu").length);
oldButtons === 0 ? ok("no button of ours on the tiles — YouTube's ⋮ is the only one") : fail(`${oldButtons} 🚫 buttons still on the page`);
const grid = await tapMenu(2);
grid && grid.menus === 1 && grid.inSheet && grid.rows.some((r) => r.text === "Block this video") && grid.rows.every((r) => r.reachable)
  ? ok(`rich grid: one set of XrnTube rows in YouTube's sheet (${grid.rows.map((r) => r.text).join(" / ")})`)
  : fail("rich grid ⋮ sheet: " + JSON.stringify(grid));
await closeSheet();
await p.waitForTimeout(800);
const leftover = await p.evaluate(() => document.querySelectorAll("bt-tile-menu").length);
leftover === 0 ? ok("closing the sheet takes our rows with it") : fail(`${leftover} row group(s) left after the sheet closed`);

// ---- 4. the watch page and the bottom bar follow the switches ----
// Every one of these is on by default and was written for the desktop's
// markup only, so on a phone the related videos, Share / Save / Report and
// the Home and Shorts tabs all stayed.
await p.goto("https://m.youtube.com/watch?v=adQyLViK_ZU", { waitUntil: "domcontentloaded" });
await p.waitForTimeout(8000);
await p.evaluate(() => window.scrollBy(0, 1500));
await p.waitForTimeout(2000);
const watch = await p.evaluate(() => {
  const vis = (e) => e.getClientRects().length > 0;
  const labels = [...document.querySelectorAll("ytm-slim-video-action-bar-renderer button")].filter(vis).map((b) => (b.getAttribute("aria-label") || "").toLowerCase());
  return {
    related: [...document.querySelectorAll("ytm-single-column-watch-next-results-renderer :is(ytm-video-with-context-renderer, yt-lockup-view-model)")].filter(vis).length,
    teaser: [...document.querySelectorAll("comments-entry-point-teaser-view-model, ytm-comments-entry-point-header-renderer")].some(vis),
    like: labels.some((l) => l.startsWith("like this video")),
    leftover: labels.filter((l) => ["share", "save to playlist", "save", "report"].includes(l))
  };
});
watch.related === 0 && watch.teaser
  ? ok("phone watch page: no related videos under the player, comments teaser still there")
  : fail("phone watch page related/teaser: " + JSON.stringify(watch));
watch.like && watch.leftover.length === 0
  ? ok("phone watch page: Share, Save and Report gone from the row, Like stays")
  : fail("phone action row: " + JSON.stringify(watch));
await p.goto("https://m.youtube.com/results?search_query=veritasium", { waitUntil: "domcontentloaded" });
await p.waitForTimeout(6000);
const pivot = await p.evaluate(() =>
  [...document.querySelectorAll("ytm-pivot-bar-item-renderer")].filter((e) => e.getClientRects().length).map((e) => (e.textContent || "").trim())
);
pivot.length > 0 && !pivot.includes("Home") && !pivot.includes("Shorts") && !pivot.includes("")
  ? ok(`bottom bar: Home and Shorts gone, no blank tab left (${pivot.join(", ")})`)
  : fail("bottom bar tabs: " + JSON.stringify(pivot));

// ---- 5. ⋮ → Block channel ----
const picked = await (async () => {
  for (let n = 0; n < 6; n += 1) {
    const m = await tapMenu(n);
    const row = m && m.rows.find((r) => /^Block channel/.test(r.text));
    if (row) return { ...m, row };
    await closeSheet();
    await p.waitForTimeout(500);
  }
  return null;
})();
if (!picked) {
  fail("no tile's ⋮ sheet offered “Block channel”");
} else {
  picked.row.reachable ? ok(`“${picked.row.text}” is on screen in the sheet, tappable`) : fail("the Block channel row is under something: " + JSON.stringify(picked));
  await p.tap('bt-tile-menu .bt-menu-row:has-text("Block channel")');
  await p.waitForTimeout(1500);
  const bl = await send({ type: "GET_BLOCKLIST" });
  const keys = Object.keys(bl.channels);
  const after = await p.evaluate(() => ({
    tile: !!document.querySelector('[data-bt-test="tile"]'),
    sheet: [...document.querySelectorAll("bottom-sheet-container #content-wrapper")].some((e) => e.getClientRects().length),
    toast: (document.querySelector("bt-toast") || {}).textContent || ""
  }));
  keys.length === 1 && !after.tile && !after.sheet && /Undo/.test(after.toast)
    ? ok(`tapping it blocks ${keys[0]}, removes the tile, closes the sheet and offers Undo`)
    : fail(`⋮ block: keys=${JSON.stringify(keys)} ${JSON.stringify(after)}`);
}

// ---- 6. tapping the logo goes to Subscriptions, without a reload ----
// The mobile logo is a <button> with no href; only the endpoint in the
// page's JSON decides where it goes (page-hook.js rewrites it).
await p.goto("https://m.youtube.com/results?search_query=mkbhd", { waitUntil: "domcontentloaded" });
await p.waitForTimeout(5000);
const docLoads = [];
const onReq = (r) => {
  if (r.resourceType() === "document" && r.frame() === p.mainFrame()) docLoads.push(r.url());
};
p.on("request", onReq);
await p.evaluate(() => (window.__btSamePage = 1));
await p.tap("ytm-home-logo .mobile-topbar-header-endpoint");
await p.waitForTimeout(4000);
p.off("request", onReq);
const samePage = await p.evaluate(() => window.__btSamePage === 1).catch(() => false);
/\/feed\/subscriptions/.test(p.url()) && samePage && docLoads.length === 0
  ? ok("tapping the logo → Subscriptions in one in-app hop (no reload)")
  : fail(`logo tap: url=${p.url()} samePage=${samePage} docLoads=${JSON.stringify(docLoads)}`);

errs.length === 0 ? ok("no page errors") : fail("page errors: " + errs.slice(0, 2).join(" | "));
await ctx.close();
console.log("\nDONE");
