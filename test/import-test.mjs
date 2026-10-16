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


// synthetic large blocklist — only the shape and size matter for these tests.
const rndId = (n) => Array.from({ length: n }, () => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"[Math.floor(Math.random()*64)]).join("");
const data = { channels: {}, videos: {} };
for (let i = 0; i < 4691; i++) data.channels["UC" + rndId(22)] = { name: "Chan " + i, ts: Date.now() - i * 1000, mode: "full", whitelist: {} };
for (let i = 0; i < 762; i++) data.videos[rndId(11)] = { title: "Vid " + i, ts: Date.now() - i * 1000 };
const _spotId = Object.keys(data.channels)[0];
data.channels[_spotId].name = "Kênh Thử Nghiệm";

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
if (spot && spot.name === "Kênh Thử Nghiệm" && (spot.mode === "full" || spot.mode === undefined)) ok("spot channel intact: " + JSON.stringify(spot));
else fail("spot channel wrong: " + JSON.stringify(spot));

// the whole blocklist is one local key now; nothing rides chrome.storage.sync
const store = await p.evaluate(async () => {
  const sync = await chrome.storage.sync.get(null);
  const { bt_blocklist: bl } = await chrome.storage.local.get("bt_blocklist");
  return {
    channels: Object.keys((bl && bl.channels) || {}).length,
    videos: Object.keys((bl && bl.videos) || {}).length,
    syncChunkKeys: Object.keys(sync).filter((k) => /^bt_(ch|vid)_|^bt_meta$/.test(k)).length
  };
});
store.channels === wantCh && store.videos === wantVid && store.syncChunkKeys === 0
  ? ok(`all ${wantCh + wantVid} entries in one local key, none in sync storage`)
  : fail("storage layout: " + JSON.stringify(store));

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

// ---- an install that still has the old layout is migrated on first load ----
// Up to v1 the blocklist sat in chrome.storage.sync as bt_meta + bt_ch_<n> /
// bt_vid_<n> chunks, plus a local bt_overflow. Seed exactly that, restart the
// extension, and everything must arrive in the new key with the old keys gone
// — and nothing else in sync storage touched.
const oldCh = (from, to) =>
  Object.fromEntries(
    Array.from({ length: to - from }, (_, i) => ["UCold" + String(from + i).padStart(19, "0"), { name: "Old " + (from + i), ts: 1, mode: "full" }])
  );
await p.evaluate(async (seed) => {
  await chrome.storage.local.remove("bt_blocklist");
  await chrome.storage.sync.set(seed.sync);
  await chrome.storage.local.set(seed.local);
}, {
  sync: {
    bt_meta: { channelChunkCount: 2, videoChunkCount: 1 },
    bt_ch_0: oldCh(0, 20),
    bt_ch_1: oldCh(20, 40),
    bt_vid_0: { oldvideo001: { title: "Old video", ts: 1 } },
    bt_settings: { removeRelated: false }
  },
  local: { bt_overflow: { channels: oldCh(40, 45), videos: { oldvideo002: { title: "Overflowed", ts: 1 } } } }
});
// Stop the service worker, as an update or a browser restart does; the next
// message starts a fresh one, whose first read runs the migration.
const cdp = await ctx.newCDPSession(p);
await cdp.send("ServiceWorker.enable");
await cdp.send("ServiceWorker.stopAllWorkers");
await new Promise((r) => setTimeout(r, 1000));
const p2 = p;
const migratedBl = await p2.evaluate(() => chrome.runtime.sendMessage({ type: "GET_BLOCKLIST" }));
const after = await p2.evaluate(async () => ({
  sync: await chrome.storage.sync.get(null),
  overflow: (await chrome.storage.local.get("bt_overflow")).bt_overflow
}));
Object.keys(migratedBl.channels).length === 45 && Object.keys(migratedBl.videos).length === 2
  ? ok("an old-layout install migrates: 40 synced + 5 overflow channels, 2 videos")
  : fail(`migration: ${Object.keys(migratedBl.channels).length} channels, ${Object.keys(migratedBl.videos).length} videos`);
!Object.keys(after.sync).some((k) => /^bt_(ch|vid)_|^bt_meta$/.test(k)) && !after.overflow
  ? ok("…and the old keys are removed afterwards")
  : fail("old keys left: " + Object.keys(after.sync).join(","));
after.sync.bt_settings && after.sync.bt_settings.removeRelated === false
  ? ok("…without touching anything else in sync storage (switches kept)")
  : fail("migration disturbed bt_settings: " + JSON.stringify(after.sync.bt_settings));

await ctx.close();
console.log("\nDONE");
