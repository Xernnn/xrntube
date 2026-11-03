import { chromium } from "playwright";

// XrnTube's block options, inside YouTube's own ⋮ menu on the desktop.
// (mobile-test covers the phone's bottom sheet.) A tile used to carry a 🚫
// button of ours beside YouTube's ⋮; now a click on the ⋮ adds our rows to
// the popup YouTube opens. What can go wrong with that, each checked here:
//   - the popup sized itself before our rows existed, so they sit clipped
//     under its edge unless it is made to refit
//   - desktop reuses one dropdown for every menu on the page, so rows left
//     behind turn up in the next menu it shows — the watch page's own "…"
//   - a related-column tile names its uploader as plain text; the channel
//     row there comes from what layer 0 read in YouTube's JSON
//   - picking a row blocks, removes the tile, closes the popup, offers Undo

const EXT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const ctx = await chromium.launchPersistentContext(
  `/tmp/bt-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
  {
    headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--headless=new", "--no-sandbox"],
    viewport: { width: 1400, height: 950 }
  }
);
const fail = (m) => {
  console.error("FAIL:", m);
  process.exitCode = 1;
};
const ok = (m) => console.log("ok:", m);

const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 15000 }));
const opt = await ctx.newPage();
await opt.goto(`chrome-extension://${sw.url().split("/")[2]}/options/options.html`);
const send = (m) => opt.evaluate((mm) => chrome.runtime.sendMessage(mm), m);
// The related column and the video's own "…" are both removed by default,
// and both are surfaces here.
await opt.evaluate(() => chrome.storage.sync.set({ bt_settings: { removeRelated: false, actionMore: false } }));
// A blocklist that names nobody on these pages still switches layer 0 on,
// which is what reads the related column's uploaders.
const NOBODY = { "@xrntube-test-nobody": { name: "Nobody", mode: "full", subsAt: Date.now(), subsV: 9 } };
await send({ type: "IMPORT_BLOCKLIST", channels: NOBODY, videos: {} });

const p = await ctx.newPage();
const errs = [];
p.on("pageerror", (e) => errs.push(e.message));

const TILES = "ytd-rich-item-renderer, ytd-video-renderer, yt-lockup-view-model";
// Click the ⋮ of the nth tile on screen and describe what opened.
const openMenu = async (nth) => {
  const found = await p.evaluate(
    ([tiles, n]) => {
      document.querySelectorAll("[data-bt-test]").forEach((e) => e.removeAttribute("data-bt-test"));
      const b = [...document.querySelectorAll("button[aria-label='Action menu'], button[aria-label='More actions']")].filter(
        (x) => x.closest(tiles) && !x.closest("ytd-watch-metadata") && x.getBoundingClientRect().top > 120
      )[n];
      if (!b) return false;
      b.scrollIntoView({ block: "center" });
      b.setAttribute("data-bt-test", "menu");
      b.closest(tiles).setAttribute("data-bt-test", "tile");
      return true;
    },
    [TILES, nth]
  );
  if (!found) return null;
  await p.waitForTimeout(400);
  await p.click('[data-bt-test="menu"]');
  await p.waitForTimeout(1300);
  return p.evaluate(() => {
    const shown = [...document.querySelectorAll("bt-tile-menu")].filter((s) => s.getClientRects().length);
    const native = shown[0] && shown[0].parentElement.querySelector("tp-yt-paper-item, yt-list-item-view-model");
    return {
      menus: shown.length,
      inPopup: shown.every((s) => !!s.closest("ytd-popup-container tp-yt-iron-dropdown")),
      nativeH: native ? Math.round(native.getBoundingClientRect().height) : 0,
      rows: shown.flatMap((s) =>
        [...s.querySelectorAll(".bt-menu-row")].map((r) => {
          const b = r.getBoundingClientRect();
          const hit = document.elementFromPoint(b.left + 30, b.top + b.height / 2);
          return {
            text: r.querySelector(".bt-menu-text").firstChild.textContent,
            h: Math.round(b.height),
            reachable: !!hit && r.contains(hit) && b.bottom <= innerHeight
          };
        })
      )
    };
  });
};
const menusOpen = () =>
  p.evaluate(() => [...document.querySelectorAll("ytd-popup-container tp-yt-iron-dropdown")].some((d) => d.getClientRects().length));
const rowGroups = () => p.evaluate(() => document.querySelectorAll("bt-tile-menu").length);

// ---- 1. search: the classic dropdown (ytd-video-renderer) ----
await p.goto("https://www.youtube.com/results?search_query=veritasium", { waitUntil: "domcontentloaded" });
await p.waitForTimeout(7000);
const oldButtons = await p.evaluate(() => document.querySelectorAll(".bt-block-btn, .bt-block-menu").length);
oldButtons === 0 ? ok("no button of ours on the tiles — YouTube's ⋮ is the only one") : fail(`${oldButtons} 🚫 buttons still on the page`);
const search = await openMenu(1);
const texts = search ? search.rows.map((r) => r.text) : [];
search && search.menus === 1 && search.inPopup && texts[0] === "Block this video" && texts.some((t) => /^Block channel: /.test(t))
  ? ok(`search ⋮: one set of rows in YouTube's dropdown (${texts.join(" / ")})`)
  : fail("search ⋮: " + JSON.stringify(search));
search && search.rows.length && search.rows.every((r) => r.reachable)
  ? ok("every row is inside the popup and on screen — it refit around them")
  : fail("rows clipped or covered: " + JSON.stringify(search && search.rows));
search && search.rows.filter((r) => !/^Block all/.test(r.text)).every((r) => r.h === search.nativeH)
  ? ok(`rows as tall as YouTube's own (${search.nativeH}px)`)
  : fail(`row heights ${JSON.stringify(search && search.rows.map((r) => r.h))} vs YouTube's ${search && search.nativeH}`);
await p.keyboard.press("Escape");
await p.waitForTimeout(700);
!(await menusOpen()) && (await rowGroups()) === 0
  ? ok("closing the menu takes our rows with it")
  : fail(`after Escape: open=${await menusOpen()} rows=${await rowGroups()}`);

// ---- 2. the watch page: lockups, layer 0's uploader, and the page's own menu ----
await p.goto("https://www.youtube.com/watch?v=aqz-KE-bpKQ", { waitUntil: "domcontentloaded" });
await p.waitForTimeout(9000);
const related = await openMenu(0);
const channelRow = related && related.rows.find((r) => /^Block channel: /.test(r.text));
related && related.menus === 1 && channelRow && channelRow.reachable
  ? ok(`related tile ⋮ offers its channel, read from YouTube's JSON (“${channelRow.text}”)`)
  : fail("related ⋮ (channel row missing — the uploader is plain text in the DOM): " + JSON.stringify(related));
related && related.nativeH && related.rows.filter((r) => !/^Block all/.test(r.text)).every((r) => r.h === related.nativeH)
  ? ok(`lockup sheet rows match its own height (${related.nativeH}px)`)
  : fail(`lockup row heights ${JSON.stringify(related && related.rows.map((r) => r.h))} vs ${related && related.nativeH}`);
await p.keyboard.press("Escape");
await p.waitForTimeout(700);
// The video's own "…" opens in the same dropdown container.
const own = await p.evaluate(() => {
  const b = [...document.querySelectorAll("ytd-watch-metadata button[aria-label='More actions']")].find((x) => x.getClientRects().length);
  if (!b) return false;
  b.setAttribute("data-bt-test", "own");
  return true;
});
if (!own) {
  fail("the watch page's own … button wasn't found");
} else {
  await p.click('[data-bt-test="own"]');
  await p.waitForTimeout(1200);
  (await menusOpen()) && (await rowGroups()) === 0
    ? ok("the video's own … menu opens without any XrnTube rows in it")
    : fail(`own menu: open=${await menusOpen()} rows=${await rowGroups()}`);
  await p.keyboard.press("Escape");
  await p.waitForTimeout(500);
}

// ---- 3. pick a row: block, remove, close, Undo ----
await p.goto("https://www.youtube.com/results?search_query=veritasium", { waitUntil: "domcontentloaded" });
await p.waitForTimeout(7000);
const m = await openMenu(1);
if (!m || !m.rows.some((r) => /^Block channel: /.test(r.text))) {
  fail("no Block channel row to pick: " + JSON.stringify(m));
} else {
  await p.click('bt-tile-menu .bt-menu-row:has-text("Block channel")');
  await p.waitForTimeout(1500);
  const keys = Object.keys((await send({ type: "GET_BLOCKLIST" })).channels).filter((k) => !(k in NOBODY));
  const after = await p.evaluate(() => ({
    tile: !!document.querySelector('[data-bt-test="tile"]'),
    toast: (document.querySelector("bt-toast") || {}).textContent || ""
  }));
  keys.length === 1 && !after.tile && !(await menusOpen()) && /Undo/.test(after.toast)
    ? ok(`picking it blocks ${keys[0]}, removes the tile, closes the menu and offers Undo`)
    : fail(`row block: keys=${JSON.stringify(keys)} ${JSON.stringify(after)} open=${await menusOpen()}`);
  await p.click("bt-toast button");
  await p.waitForTimeout(1500);
  const left = Object.keys((await send({ type: "GET_BLOCKLIST" })).channels).filter((k) => !(k in NOBODY));
  left.length === 0 ? ok("Undo unblocks it") : fail(`after Undo: ${JSON.stringify(left)}`);
}

errs.length === 0 ? ok("no page errors") : fail("page errors: " + errs.slice(0, 2).join(" | "));
await ctx.close();
console.log("\nDONE");
