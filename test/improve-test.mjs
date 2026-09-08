import { chromium } from "playwright";

const EXT_PATH = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const ctx = await chromium.launchPersistentContext(`/tmp/bt-test-${process.pid}-${Math.random().toString(36).slice(2)}`, {
  headless: false,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox"],
});
const fail = (m) => { console.error("FAIL:", m); process.exitCode = 1; };
const ok = (m) => console.log("ok:", m);

let sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 10000 }));
const extId = sw.url().split("/")[2];
const swErr = [];
sw.on("console", (m) => { if (m.type() === "error") swErr.push(m.text()); });

const ext = await ctx.newPage();
ext.on("dialog", (d) => d.accept());
await ext.goto(`chrome-extension://${extId}/options/options.html`);
await ext.waitForLoadState("domcontentloaded");
await ext.waitForTimeout(300);
const send = (m) => ext.evaluate((mm) => chrome.runtime.sendMessage(mm), m);

// ================= 1. recently-unblocked / undo =================
await send({ type: "BLOCK_CHANNEL", id: "@undome", name: "Undo Me", mode: "exceptWhitelist" });
await send({ type: "WHITELIST_CHANNEL_VIDEO", id: "@undome", videoId: "keepthisone", title: "kept" });
await send({ type: "UNBLOCK_CHANNEL", id: "@undome" });
let rec = await send({ type: "GET_RECENT_UNBLOCKS" });
const one = rec.log[0];
(one && one.t === "one" && one.entry && one.entry.name === "Undo Me" && one.entry.whitelist && one.entry.whitelist.keepthisone)
  ? ok("unblock logged with full entry (mode + whitelist preserved)")
  : fail("recent-unblock record wrong: " + JSON.stringify(one));
await send({ type: "RESTORE_UNBLOCK", index: 0 });
let bl = await send({ type: "GET_BLOCKLIST" });
(bl.channels["@undome"] && bl.channels["@undome"].mode === "exceptWhitelist" && bl.channels["@undome"].whitelist.keepthisone)
  ? ok("restore re-added the channel with its mode + whitelist intact")
  : fail("restore lost data: " + JSON.stringify(bl.channels["@undome"]));
rec = await send({ type: "GET_RECENT_UNBLOCKS" });
rec.log.length === 0 ? ok("restored record removed from the log") : fail("log still has it");
await send({ type: "UNBLOCK_CHANNEL", id: "@undome" });

for (const v of ["vid00000001", "vid00000002", "vid00000003"]) await send({ type: "BLOCK_VIDEO", id: v, title: "T" + v });
await send({ type: "CLEAR_BLOCKED_VIDEOS" });
rec = await send({ type: "GET_RECENT_UNBLOCKS" });
const bulk = rec.log.find((r) => r.t === "bulk");
(bulk && bulk.count === 3)
  ? ok("mass-delete logged as one bulk record (count 3)")
  : fail("bulk record wrong: " + JSON.stringify(rec.log));
await send({ type: "RESTORE_UNBLOCK", index: rec.log.indexOf(bulk) });
bl = await send({ type: "GET_BLOCKLIST" });
Object.keys(bl.videos).length === 3 ? ok("restore brought back all 3 videos") : fail(`${Object.keys(bl.videos).length} videos after bulk restore`);
await send({ type: "CLEAR_BLOCKED_VIDEOS" });
await send({ type: "CLEAR_RECENT_UNBLOCKS" });

// ================= 2. keyword title blocking =================
await ext.evaluate((k) => chrome.storage.sync.set({ [k]: { list: [{ p: "iphone", re: false }], ts: Date.now() } }), "bt_keywords");
await ext.waitForTimeout(300);
const kwPage = await ctx.newPage();
await kwPage.goto("https://www.youtube.com/results?search_query=iphone+16+review", { waitUntil: "domcontentloaded" });
await kwPage.waitForTimeout(7000);
const kwLeft = await kwPage.evaluate(() =>
  [...document.querySelectorAll('ytd-video-renderer')].filter((t) => { const x = t.querySelector('#video-title'); return x && /iphone/i.test(x.textContent || ''); }).length
);
console.log("   video tiles with 'iphone' after keyword filter:", kwLeft);
kwLeft === 0 ? ok("keyword 'iphone' removed every iphone-titled video tile") : fail(`${kwLeft} iphone tiles survived`);
await ext.evaluate((k) => chrome.storage.sync.set({ [k]: { list: [], ts: Date.now() } }), "bt_keywords");
await kwPage.reload({ waitUntil: "domcontentloaded" });
await kwPage.waitForTimeout(6000);
const kwBack = await kwPage.evaluate(() =>
  [...document.querySelectorAll('ytd-video-renderer')].filter((t) => { const x = t.querySelector('#video-title'); return x && /iphone/i.test(x.textContent || ''); }).length
);
await kwPage.close();
kwBack > 0 ? ok(`keyword removed -> iphone tiles back (${kwBack})`) : fail("tiles did not return");

// ================= 3. ucid captured on @handle entries =================
await send({ type: "BLOCK_CHANNEL", id: "@veritasium", name: "V", mode: "full" });
await send({ type: "BULK_FETCH_CHANNEL_INFO", ids: ["@veritasium"] });
bl = await send({ type: "GET_BLOCKLIST" });
const vv = bl.channels["@veritasium"];
(vv && /^UC[\w-]{22}$/.test(vv.ucid || ""))
  ? ok(`enrich stored ucid ${vv.ucid} on the @handle-keyed entry`)
  : fail("no ucid captured: " + JSON.stringify(vv));
await send({ type: "REBROADCAST_BLOCKLIST" });
const vp = await ctx.newPage();
await vp.goto("https://www.youtube.com/feed/subscriptions", { waitUntil: "domcontentloaded" });
await vp.waitForTimeout(5000);
const hasUcidRule = await vp.evaluate((uc) => {
  const s = document.getElementById("bt-instant-hide");
  return !!s && s.textContent.includes('a[href="/channel/' + uc + '"]');
}, vv.ucid);
await vp.close();
hasUcidRule ? ok("instant-hide CSS emits a /channel/UC… rule for the @handle entry") : fail("no ucid CSS rule");
await send({ type: "UNBLOCK_CHANNEL", id: "@veritasium" });

// ================= 4. sync status shape =================
const st = await send({ type: "GET_SYNC_STATUS" });
("gistUrl" in st && "remoteChannels" in st && "remoteVideos" in st)
  ? ok("sync status exposes gistUrl + remote counts")
  : fail("sync status missing new fields: " + JSON.stringify(st));

// ================= 5. :has() selector cap (big import, done last) =================

// synthetic large blocklist (was the user's personal export) — only the
// shape and size matter for these tests.
const rndId = (n) => Array.from({ length: n }, () => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"[Math.floor(Math.random()*64)]).join("");
const data = { channels: {}, videos: {} };
for (let i = 0; i < 4691; i++) data.channels["UC" + rndId(22)] = { name: "Chan " + i, ts: Date.now() - i * 1000, mode: "full", whitelist: {} };
for (let i = 0; i < 762; i++) data.videos[rndId(11)] = { title: "Vid " + i, ts: Date.now() - i * 1000 };
const _spotId = Object.keys(data.channels)[0];
data.channels[_spotId].name = "Hay Phết";

await send({ type: "IMPORT_BLOCKLIST", channels: data.channels, videos: data.videos });
await ext.waitForTimeout(600);
const yt = await ctx.newPage();
await yt.goto("https://www.youtube.com/feed/subscriptions", { waitUntil: "domcontentloaded" });
await yt.waitForTimeout(6000);
const styleStats = await yt.evaluate(() => {
  const s = document.getElementById("bt-instant-hide");
  const t = s ? s.textContent : "";
  return {
    channelSelectors: (t.match(/a\[href="\/(channel\/UC|@)/g) || []).length,
    videoSelectors: (t.match(/a\[href\*="v=/g) || []).length,
  };
});
await yt.close();
console.log("   instant-hide style:", JSON.stringify(styleStats), " (blocklist:", Object.keys(data.channels).length, "channels)");
styleStats.channelSelectors > 0 && styleStats.channelSelectors <= 3200
  ? ok(`:has() channel selectors capped at ${styleStats.channelSelectors}, not ${Object.keys(data.channels).length}`)
  : fail(`channel selector count not capped: ${styleStats.channelSelectors}`);
styleStats.videoSelectors <= 1000
  ? ok(`:has() video selectors capped at ${styleStats.videoSelectors}`)
  : fail(`video selectors not capped: ${styleStats.videoSelectors}`);

await ext.waitForTimeout(300);
swErr.length ? fail("SW errors:\n" + swErr.join("\n")) : ok("no service worker console errors");
await ctx.close();
console.log("\nDONE");
