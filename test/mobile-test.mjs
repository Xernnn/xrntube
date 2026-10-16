import { chromium, devices } from "playwright";

// m.youtube.com, as a phone browser (Quetta, Kiwi…) loads it: a phone's user
// agent, viewport and touch, no hover. Covers what the desktop suite can't:
//   - a blocked channel's videos leave mobile search, its page redirects
//   - the popup's target on a mobile watch page names the channel and title
//   - the tile 🚫 button shows without hover, and tapping it blocks
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

// ---- 3. one 🚫 per tile ----
// A channel's Videos tab is a rich grid: every cell is
// `ytm-rich-item-renderer > ytm-compact-video-renderer`, both of them tiles,
// and each used to get a button — two XrnTube menus per video.
await p.goto("https://m.youtube.com/@veritasium/videos", { waitUntil: "domcontentloaded" });
await p.waitForTimeout(7000);
const grid = await p.evaluate(() => {
  const hosts = [...document.querySelectorAll(".bt-block-btn")].map((b) => b.parentElement);
  return { buttons: hosts.length, nested: hosts.filter((h) => hosts.some((o) => o !== h && o.contains(h))).length };
});
grid.buttons >= 5 && grid.nested === 0
  ? ok(`rich grid: one 🚫 per cell (${grid.buttons} buttons, none inside another tile's)`)
  : fail("rich grid buttons: " + JSON.stringify(grid));

// ---- 4. a 🚫 never draws over YouTube's own overlays ----
// Every button is always shown on a touch screen, and its page-wide z-index
// put the one of a tile scrolled under the sticky watch-page player on top
// of the video. Scroll a button right under the player and hit-test it: a
// button is rightly on top exactly where, without it, its own tile is. (Not
// on the rich grid above: there the old twin buttons covered for each other.)
await p.goto("https://m.youtube.com/watch?v=adQyLViK_ZU", { waitUntil: "domcontentloaded" });
await p.waitForTimeout(8000);
const overlay = await p.evaluate(async () => {
  const pinned = (e) => {
    for (let n = e; n; n = n.parentElement) if (/fixed|sticky/.test(getComputedStyle(n).position)) return n;
    return null;
  };
  const player = pinned(document.elementFromPoint(innerWidth / 2, 150));
  if (!player) return { player: false };
  const pr = player.getBoundingClientRect();
  const playerMid = (pr.top + pr.bottom) / 2;
  const mid = (b) => (b.getBoundingClientRect().top + b.getBoundingClientRect().bottom) / 2;
  const btns = [...document.querySelectorAll(".bt-block-btn")];
  const target = btns.find((b) => mid(b) > pr.bottom + 50);
  if (!target) return { player: true, target: false };
  window.scrollBy(0, mid(target) - playerMid);
  await new Promise((r) => setTimeout(r, 500));
  let covered = 0;
  let bleeding = 0;
  let buried = 0;
  for (const b of document.querySelectorAll(".bt-block-btn")) {
    const r = b.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    if (!r.width || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
    b.style.visibility = "hidden";
    const under = document.elementFromPoint(x, y);
    b.style.visibility = "";
    const top = document.elementFromPoint(x, y);
    const own = !!under && b.parentElement.contains(under);
    const onTop = !!top && b.contains(top);
    if (!own) covered++;
    if (!own && onTop) bleeding++;
    if (own && !onTop) buried++;
  }
  return { player: true, target: true, covered, bleeding, buried };
});
overlay.covered > 0 && overlay.bleeding === 0 && overlay.buried === 0
  ? ok(`a 🚫 under the sticky player stays under it (${overlay.covered} covered, none drawn on top)`)
  : fail("🚫 vs YouTube's overlays: " + JSON.stringify(overlay));

// ---- 5. tap 🚫 → Block channel ----
await p.goto("https://m.youtube.com/results?search_query=veritasium", { waitUntil: "domcontentloaded" });
await p.waitForTimeout(7000);
const shown = await p.evaluate(() =>
  [...document.querySelectorAll(".bt-block-btn")].filter((b) => getComputedStyle(b).opacity !== "0").length
);
shown > 0 ? ok(`🚫 buttons visible without hover (${shown})`) : fail("no 🚫 button visible on a touch screen");
const picked = await p.evaluate(() => {
  for (const b of document.querySelectorAll(".bt-block-btn")) {
    const opt = [...b.parentElement.querySelectorAll(".bt-block-menu button")].find((x) => /^Block channel/.test(x.textContent));
    if (opt) {
      b.setAttribute("data-bt-test", "1");
      return opt.textContent;
    }
  }
  return null;
});
if (!picked) {
  fail("no tile offered “Block channel”");
} else {
  await p.tap('.bt-block-btn[data-bt-test="1"]');
  await p.waitForTimeout(300);
  await p.tap('.bt-block-btn[data-bt-test="1"] ~ .bt-block-menu button:has-text("Block channel")');
  await p.waitForTimeout(1500);
  const bl = await send({ type: "GET_BLOCKLIST" });
  const keys = Object.keys(bl.channels);
  keys.length === 1 && (await p.locator('[data-bt-test="1"]').count()) === 0
    ? ok(`tapping 🚫 → ${picked.trim()} blocks it and removes the tile (${keys[0]})`)
    : fail(`tap-to-block: keys=${JSON.stringify(keys)}`);
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
