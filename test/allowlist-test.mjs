import { chromium } from "playwright";

// Covers the "Never-block" allow-list: a hard override that beats a direct
// block, a title-keyword filter and the pre-paint CSS layer.

const EXT_PATH = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const SEARCH = "https://www.youtube.com/results?search_query=mkbhd+iphone+review";
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

const countMkbhd = (p) =>
  p.evaluate(() =>
    [...document.querySelectorAll("ytd-video-renderer, ytd-rich-item-renderer, yt-lockup-view-model")].filter(
      (t) => t.querySelector('a[href="/@mkbhd" i], a[href="/@MKBHD"]')
    ).length
  );

// Block @mkbhd fully, confirm the search page removes its tiles.
await send({ type: "BLOCK_CHANNEL", id: "@MKBHD", name: "MKBHD", mode: "full" });
await ext.waitForTimeout(200);

let p = await ctx.newPage();
await p.goto(SEARCH, { waitUntil: "domcontentloaded" });
await p.waitForTimeout(8000);
const blocked = await countMkbhd(p);
await p.close();
blocked === 0 ? ok("baseline: @MKBHD blocked, 0 tiles on search") : fail(`${blocked} tiles despite a full block`);

// Add @mkbhd to the allow-list — now nothing from it should be hidden.
const ar = await send({ type: "ALLOW_CHANNEL", id: "@mkbhd" });
console.log("   ALLOW_CHANNEL ->", JSON.stringify(ar));
const bl = await send({ type: "GET_BLOCKLIST" });
bl.allowlist && bl.allowlist["@mkbhd"]
  ? ok("GET_BLOCKLIST payload carries the allow-list")
  : fail("allow-list missing from GET_BLOCKLIST: " + JSON.stringify(bl.allowlist));

p = await ctx.newPage();
await p.goto(SEARCH, { waitUntil: "domcontentloaded" });
await p.waitForTimeout(8000);
const afterAllow = await countMkbhd(p);
const cssHasHandle = await p.evaluate(() => {
  const s = document.getElementById("bt-instant-hide");
  return !!s && /a\[href="\/@mkbhd"/i.test(s.textContent);
});
await p.close();
afterAllow > 0
  ? ok(`allow-list overrides the block: ${afterAllow} @MKBHD tiles visible again`)
  : fail("allow-listed channel still fully hidden (JS scrub or CSS layer still firing)");
!cssHasHandle
  ? ok("pre-paint CSS no longer targets the allow-listed handle")
  : fail("instant-hide CSS still has an /@mkbhd rule for an allow-listed channel");

// Its own channel page should load (not redirect to Subscriptions).
p = await ctx.newPage();
await p.goto("https://www.youtube.com/@MKBHD/videos", { waitUntil: "domcontentloaded" });
await p.waitForTimeout(6000);
const url = p.url();
await p.close();
/\/@MKBHD/i.test(url)
  ? ok("allow-listed channel page stays put (no DNR / SPA redirect)")
  : fail(`channel page redirected to ${url}`);

// Remove from the allow-list -> the block is back in force.
await send({ type: "DISALLOW_CHANNEL", id: "@mkbhd" });
await ext.waitForTimeout(200);
p = await ctx.newPage();
await p.goto(SEARCH, { waitUntil: "domcontentloaded" });
await p.waitForTimeout(8000);
const afterRemove = await countMkbhd(p);
await p.close();
afterRemove === 0
  ? ok("removing from the allow-list restores the block (0 tiles)")
  : fail(`${afterRemove} tiles still visible after DISALLOW_CHANNEL`);

await send({ type: "UNBLOCK_CHANNEL", id: "@MKBHD" });
await ctx.close();
console.log("\nDONE");
