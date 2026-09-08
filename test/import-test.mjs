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


// synthetic large blocklist (was the user's personal export) — only the
// shape and size matter for these tests.
const rndId = (n) => Array.from({ length: n }, () => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"[Math.floor(Math.random()*64)]).join("");
const data = { channels: {}, videos: {} };
for (let i = 0; i < 4691; i++) data.channels["UC" + rndId(22)] = { name: "Chan " + i, ts: Date.now() - i * 1000, mode: "full", whitelist: {} };
for (let i = 0; i < 762; i++) data.videos[rndId(11)] = { title: "Vid " + i, ts: Date.now() - i * 1000 };
const _spotId = Object.keys(data.channels)[0];
data.channels[_spotId].name = "Hay Phết";

const wantCh = Object.keys(data.channels).length;
const wantVid = Object.keys(data.videos).length;
console.log(`   import file: ${wantCh} channels, ${wantVid} videos`);

const t0 = Date.now();
let res;
try {
  res = await p.evaluate(
    (d) => chrome.runtime.sendMessage({ type: "IMPORT_BLOCKLIST", channels: d.channels, videos: d.videos }),
    data
  );
} catch (e) {
  fail("evaluate threw: " + e.message);
  await new Promise((r) => setTimeout(r, 500));
  console.log("   SW errors so far:\n" + (swErr.join("\n") || "(none captured)"));
  await ctx.close();
  process.exit(1);
}
console.log(`   IMPORT_BLOCKLIST -> ${JSON.stringify(res)}  (${Date.now() - t0} ms)`);

if (res && res.ok && res.channels === wantCh && res.videos === wantVid) ok("import result counts match file");
else fail(`counts off: got ${JSON.stringify(res)} want ch=${wantCh} vid=${wantVid}`);

// read it back through GET_BLOCKLIST
const bl = await p.evaluate(() => chrome.runtime.sendMessage({ type: "GET_BLOCKLIST" }));
const gotCh = Object.keys(bl.channels).length, gotVid = Object.keys(bl.videos).length;
if (gotCh === wantCh && gotVid === wantVid) ok(`GET_BLOCKLIST returns all (${gotCh} ch, ${gotVid} vid)`);
else fail(`GET_BLOCKLIST off: ${gotCh} ch, ${gotVid} vid`);

// spot-check a specific entry survived with name + mode
const spot = bl.channels[_spotId];
if (spot && spot.name === "Hay Phết" && (spot.mode === "full" || spot.mode === undefined)) ok("spot channel intact: " + JSON.stringify(spot));
else fail("spot channel wrong: " + JSON.stringify(spot));

// how many landed in sync vs local overflow
const store = await p.evaluate(async () => {
  const sync = await chrome.storage.sync.get(null);
  const local = await chrome.storage.local.get("bt_overflow");
  const meta = sync.bt_meta || {};
  const chunkCount = (k) => Object.keys(sync).filter((x) => x.startsWith(k)).reduce((n, x) => n + Object.keys(sync[x]).length, 0);
  const ov = local.bt_overflow || { channels: {}, videos: {} };
  return {
    syncChannels: chunkCount("bt_ch_"),
    syncVideos: chunkCount("bt_vid_"),
    overflowChannels: Object.keys(ov.channels).length,
    overflowVideos: Object.keys(ov.videos).length,
    meta,
  };
});
console.log("   storage split:", JSON.stringify(store));
if (store.syncChannels + store.syncVideos <= 480) ok("sync side within MAX_SYNC_ITEMS cap");
else fail("sync side over cap: " + (store.syncChannels + store.syncVideos));
if (store.syncChannels + store.syncVideos + store.overflowChannels + store.overflowVideos === wantCh + wantVid)
  ok("every entry accounted for (sync + overflow)");
else fail("entry total mismatch");

// re-import is idempotent
const res2 = await p.evaluate(
  (d) => chrome.runtime.sendMessage({ type: "IMPORT_BLOCKLIST", channels: d.channels, videos: d.videos }),
  data
);
if (res2.channels === wantCh && res2.videos === wantVid) ok("re-import idempotent (no dupes/growth)");
else fail("re-import changed counts: " + JSON.stringify(res2));

await new Promise((r) => setTimeout(r, 300));
if (swErr.length) fail("SW console errors:\n" + swErr.join("\n"));
else ok("no service worker console errors");

await ctx.close();
console.log("\nDONE");
