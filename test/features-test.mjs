import { chromium } from "playwright";

const EXT_PATH = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const ctx = await chromium.launchPersistentContext(`/tmp/bt-test-${process.pid}-${Math.random().toString(36).slice(2)}`, {
  headless: false,
  args: [
    `--disable-extensions-except=${EXT_PATH}`,
    `--load-extension=${EXT_PATH}`,
    "--headless=new",
    "--no-sandbox",
  ],
});
const fail = (m) => { console.error("FAIL:", m); process.exitCode = 1; };
const ok = (m) => console.log("ok:", m);

let sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 10000 }));
const extId = sw.url().split("/")[2];
const swErr = [];
sw.on("console", (m) => { if (m.type() === "error") swErr.push(m.text()); });

const p = await ctx.newPage();
p.on("pageerror", (e) => fail("options pageerror: " + e.message));
await p.goto(`chrome-extension://${extId}/options/options.html`);
await p.waitForLoadState("domcontentloaded");
const send = (m) => p.evaluate((mm) => chrome.runtime.sendMessage(mm), m);

// --- seed: a full channel, a video-only channel, a blocked video ---
// MrBeast (UCX6OQ3DkcsbYNE6H8uQQuVA) is a safe, huge public channel to scrape.
await send({ type: "BLOCK_CHANNEL", id: "UCX6OQ3DkcsbYNE6H8uQQuVA", name: "MrBeast", mode: "full" });
await send({ type: "BLOCK_CHANNEL", id: "@mkbhd", name: "MKBHD", mode: "exceptWhitelist" });
await send({ type: "BLOCK_VIDEO", id: "dQw4w9WgXcQ", title: "Rick" });
await p.waitForTimeout(200);

// --- 1. hide / unhide ---
let r = await send({ type: "SET_ENTRY_HIDDEN", kind: "channel", id: "UCX6OQ3DkcsbYNE6H8uQQuVA", hidden: true });
r && r.ok ? ok("SET_ENTRY_HIDDEN ok") : fail("hide failed: " + JSON.stringify(r));
let bl = await send({ type: "GET_BLOCKLIST" });
bl.channels["UCX6OQ3DkcsbYNE6H8uQQuVA"].hidden === true
  ? ok("channel entry marked hidden (still present/blocked)")
  : fail("hidden flag not set: " + JSON.stringify(bl.channels["UCX6OQ3DkcsbYNE6H8uQQuVA"]));
await send({ type: "SET_ENTRY_HIDDEN", kind: "channel", id: "UCX6OQ3DkcsbYNE6H8uQQuVA", hidden: false });
bl = await send({ type: "GET_BLOCKLIST" });
!bl.channels["UCX6OQ3DkcsbYNE6H8uQQuVA"].hidden ? ok("unhide clears the flag") : fail("still hidden");

// --- 2. age rule ---
r = await send({ type: "SET_CHANNEL_AGE_RULE", id: "@mkbhd", days: 14 });
r && r.days === 14 ? ok("SET_CHANNEL_AGE_RULE -> 14") : fail("age rule set failed: " + JSON.stringify(r));
bl = await send({ type: "GET_BLOCKLIST" });
bl.channels["@mkbhd"].blockOlderThanDays === 14 ? ok("blockOlderThanDays persisted") : fail("not persisted");
await send({ type: "SET_CHANNEL_AGE_RULE", id: "@mkbhd", days: 0 });
bl = await send({ type: "GET_BLOCKLIST" });
bl.channels["@mkbhd"].blockOlderThanDays === 0 ? ok("age rule cleared with 0") : fail("not cleared");

// --- 3. subscriber scrape (needs network) ---
r = await send({ type: "FETCH_CHANNEL_SUBS", id: "UCX6OQ3DkcsbYNE6H8uQQuVA" });
console.log("   FETCH_CHANNEL_SUBS ->", JSON.stringify(r));
if (r && r.ok && /^[\d.,]+\s?[KMB]?$/i.test(r.subs || "")) {
  ok("scraped a sub count: " + r.subs);
  bl = await send({ type: "GET_BLOCKLIST" });
  bl.channels["UCX6OQ3DkcsbYNE6H8uQQuVA"].subs === r.subs && bl.channels["UCX6OQ3DkcsbYNE6H8uQQuVA"].subsAt
    ? ok("sub count cached on entry with subsAt")
    : fail("not cached: " + JSON.stringify(bl.channels["UCX6OQ3DkcsbYNE6H8uQQuVA"]));
} else {
  console.log("   (sub scrape returned nothing — network blocked or consent wall; not failing the run)");
}

// --- 4. options UI: tabs + rendered rows ---
await p.reload();
await p.waitForLoadState("domcontentloaded");
await p.waitForTimeout(400);
const tabCount = await p.locator("#filter-by option").count();
tabCount === 6 ? ok("6 filter options in the Show control") : fail("filter option count: " + tabCount);

await p.selectOption("#filter-by", "videos");
await p.waitForTimeout(100);
const chHiddenOnVideosTab = await p.locator("#channel-section").isHidden();
const vidRows = await p.locator("#video-list li").count();
chHiddenOnVideosTab && vidRows === 1
  ? ok("Videos tab: channel section hidden, 1 video row")
  : fail(`Videos tab wrong: chHidden=${chHiddenOnVideosTab} vidRows=${vidRows}`);

await p.selectOption("#filter-by", "videoOnly");
await p.waitForTimeout(100);
const voRows = await p.locator("#channel-list li").count();
const hasWhitelistPanel = await p.locator("#channel-list .whitelist .age-rule").count();
voRows === 1 && hasWhitelistPanel === 1
  ? ok("Video-only tab: 1 channel with an age-rule control")
  : fail(`videoOnly tab wrong: rows=${voRows} agePanels=${hasWhitelistPanel}`);

await p.selectOption("#filter-by", "full");
await p.waitForTimeout(100);
const fullRows = await p.locator("#channel-list li").count();
const subsChips = await p.locator("#channel-list .subs-chip").count();
fullRows === 1 && subsChips === 1
  ? ok("Full-blocked tab: 1 channel with a subs chip")
  : fail(`full tab wrong: rows=${fullRows} chips=${subsChips}`);

// Hide from the UI, then check the Hidden tab. Hide lives in the row's ⋯
// drawer now — the row keeps only Unblock — so the drawer has to be opened
// first. That disclosure IS the interaction, so drive it rather than reaching
// past it into a hidden element.
await p.locator("#channel-list .row-more-btn").first().click();
await p.waitForTimeout(300);
await p.locator("#channel-list .hide-btn").first().click();
await p.waitForTimeout(300);
const fullRowsAfterHide = await p.locator("#channel-list li").count();
await p.selectOption("#filter-by", "hidden");
await p.waitForTimeout(150);
const hiddenTabText = await p.locator('#filter-by option[value="hidden"]').textContent();
const hiddenRows = await p.locator("#channel-list li").count();
fullRowsAfterHide === 0 && /Hidden \(1\)/.test(hiddenTabText) && hiddenRows === 1
  ? ok("Hide button works; Hidden tab shows the row and count")
  : fail(`hide flow wrong: afterHide=${fullRowsAfterHide} tabText="${hiddenTabText}" hiddenRows=${hiddenRows}`);

await p.waitForTimeout(300);
if (swErr.length) fail("SW console errors:\n" + swErr.join("\n"));
else ok("no service worker console errors");

await ctx.close();
console.log("\nDONE");
