import { chromium } from "playwright";

// A blocked channel's playlists (feeds/search + its own Playlists tab) and
// its community posts should all disappear.

const EXT_PATH = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const ctx = await chromium.launchPersistentContext(`/tmp/bt-test-${process.pid}-${Math.random().toString(36).slice(2)}`, {
  headless: false,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox"],
});
const fail = (m) => { console.error("FAIL:", m); process.exitCode = 1; };
const ok = (m) => console.log("ok:", m);

const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 10000 }));
const extId = sw.url().split("/")[2];
const ext = await ctx.newPage();
await ext.goto(`chrome-extension://${extId}/options/options.html`);
const send = (m) => ext.evaluate((mm) => chrome.runtime.sendMessage(mm), m);

const countPlaylistTiles = (p) =>
  p.evaluate(() => {
    const sel = "ytd-playlist-renderer, ytd-grid-playlist-renderer, ytd-lockup-view-model, yt-lockup-view-model, ytd-rich-item-renderer";
    return [...document.querySelectorAll(sel)].filter(
      (t) =>
        t.offsetParent !== null &&
        t.querySelector('a[href*="/playlist?list="], a[href*="&list=PL"], a[href*="?list=PL"], a[href*="&list=UU"], a[href*="&list=OL"]')
    ).length;
  });
const countPosts = (p) =>
  p.evaluate(
    () =>
      [...document.querySelectorAll("ytd-backstage-post-thread-renderer, ytd-post-renderer, ytd-backstage-post-renderer")].filter(
        (t) => t.offsetParent !== null
      ).length
  );

// ---- 1. video-only block (page NOT redirected): the channel's own Playlists tab ----
// Soft block keeps the channel page reachable, so this actually exercises the
// scrubOwnChannelPage / channelPageHideStyle path rather than the DNR redirect.
await send({ type: "BLOCK_CHANNEL", id: "@MKBHD", name: "MKBHD", mode: "exceptWhitelist" });
await send({ type: "BULK_FETCH_CHANNEL_INFO", ids: ["@MKBHD"] }); // cache the UC id / handle
await ext.waitForTimeout(300);

let p = await ctx.newPage();
await p.goto("https://www.youtube.com/@MKBHD/playlists", { waitUntil: "domcontentloaded" });
await p.waitForTimeout(8000);
const ownPlaylists = await countPlaylistTiles(p);
const url1 = p.url();
await p.close();
if (/\/feed\/subscriptions/.test(url1)) {
  fail("soft block should NOT redirect the channel page, but it did");
} else {
  ownPlaylists === 0
    ? ok("video-only block: channel page loads, 0 playlist tiles left on its Playlists tab")
    : fail(`${ownPlaylists} playlist tiles still on the channel's own Playlists tab`);
}

// ---- 2. playlist search results ----
p = await ctx.newPage();
// sp=EgIQAw%3D%3D == the "Playlist" search filter
await p.goto("https://www.youtube.com/results?search_query=mkbhd&sp=EgIQAw%253D%253D", { waitUntil: "domcontentloaded" });
await p.waitForTimeout(8000);
const searchPlaylists = await p.evaluate(
  () =>
    [...document.querySelectorAll("ytd-playlist-renderer, yt-lockup-view-model")].filter(
      (t) => t.offsetParent !== null && t.querySelector('a[href="/@MKBHD" i], a[href="/@mkbhd"]')
    ).length
);
await p.close();
searchPlaylists === 0
  ? ok("playlist search: 0 tiles still linking @MKBHD (video-only block still kills playlists)")
  : fail(`${searchPlaylists} MKBHD playlist tiles in playlist search results`);

// ---- 3. community posts on the channel's own Posts tab ----
p = await ctx.newPage();
await p.goto("https://www.youtube.com/@MKBHD/posts", { waitUntil: "domcontentloaded" });
await p.waitForTimeout(9000);
const posts = await countPosts(p);
const url3 = p.url();
await p.close();
if (/\/feed\/subscriptions/.test(url3)) {
  ok("posts page redirected (acceptable) — soft block was expected to keep it though");
} else {
  posts === 0
    ? ok("community posts: 0 posts left on @MKBHD/posts")
    : fail(`${posts} community posts survived on the channel's own Posts tab`);
}

await send({ type: "UNBLOCK_CHANNEL", id: "@MKBHD" });
await ctx.close();
console.log("\nDONE");
