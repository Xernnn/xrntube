import { readFileSync } from "fs";
import { chromium } from "playwright";

// The data tools on the options page and the background messages behind them:
// importing without duplicating a channel stored under its other identity,
// bulk `ids` messages, DELETE_DATA + undo-by-stamp, a full backup round trip
// through the UI (channels, videos, keywords, never-block, switches), the
// per-row Delete + Undo toast, and the typed confirmation that guards
// "Delete everything".
//
// Synthetic data only, and every channel is pre-stamped with the current
// scrape version so the options page never starts a sub-count sweep: this
// file needs the extension but not the network.

const EXT_PATH = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const ctx = await chromium.launchPersistentContext(`/tmp/bt-test-${process.pid}-${Math.random().toString(36).slice(2)}`, {
  headless: false,
  acceptDownloads: true,
  viewport: { width: 1400, height: 1000 },
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox"]
});
const fail = (m) => {
  console.error("FAIL:", m);
  process.exitCode = 1;
};
const ok = (m) => console.log("ok:", m);

const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 15000 }));
const swErr = [];
sw.on("console", (m) => {
  if (m.type() === "error") swErr.push(m.text());
});
const extId = sw.url().split("/")[2];
const p = await ctx.newPage();
const errs = [];
p.on("pageerror", (e) => errs.push(String(e)));
await p.goto(`chrome-extension://${extId}/options/options.html`);
await p.waitForTimeout(600);

const msg = (m) => p.evaluate((mm) => chrome.runtime.sendMessage(mm), m);
const blocklist = () => msg({ type: "GET_BLOCKLIST" });
const SUBS_V = await p.evaluate(() => self.XrnTube.SUBS_SCRAPE_VERSION);
const now = Date.now();
const stamped = (extra) => ({ ts: now, subsAt: now, subsV: SUBS_V, mode: "full", whitelist: {}, ...extra });

const UC_A = "UCaaaaaaaaaaaaaaaaaaaaaa";
const UC_B = "UCbbbbbbbbbbbbbbbbbbbbbb";
const UC_C = "UCcccccccccccccccccccccc";
await msg({
  type: "IMPORT_BLOCKLIST",
  channels: {
    [UC_A]: stamped({ name: "Chan A", handle: "@ChanA" }),
    "@chanb": stamped({ name: "", ucid: UC_B }),
    [UC_C]: stamped({ name: "Chan C", subs: "3K" })
  },
  videos: { vvvvvvvvvv1: { title: "One", ts: now }, vvvvvvvvvv2: { title: "", ts: now } }
});

// ---- 1. import matches a channel by either identity ----
const r1 = await msg({
  type: "IMPORT_BLOCKLIST",
  channels: {
    "@chana": { name: "Chan A", subs: "5K", subsAt: now, subsV: SUBS_V }, // A, named by its handle
    [UC_B]: { name: "Real B" } // B, named by its UC id
  },
  videos: { vvvvvvvvvv2: { title: "Two" } }
});
let bl = await blocklist();
r1.added.channels === 0 && Object.keys(bl.channels).length === 3
  ? ok("a channel named by its other identity is matched, not duplicated")
  : fail(`import duplicated: ${JSON.stringify(r1)} keys=${Object.keys(bl.channels).join(",")}`);
bl.channels[UC_A].subs === "5K" && bl.channels["@chanb"].name === "Real B" && bl.videos.vvvvvvvvvv2.title === "Two"
  ? ok(`…and fills in what the existing entry lacked (enriched=${r1.enriched})`)
  : fail("enrichment missing: " + JSON.stringify([bl.channels[UC_A], bl.channels["@chanb"], bl.videos.vvvvvvvvvv2]));

// ---- 2. bulk `ids` messages ----
await msg({ type: "SET_CHANNEL_MODE", ids: [UC_A, "@chanb"], mode: "exceptWhitelist" });
await msg({ type: "SET_ENTRY_HIDDEN", kind: "video", ids: ["vvvvvvvvvv1", "vvvvvvvvvv2"], hidden: true });
await msg({ type: "ALLOW_CHANNEL", ids: ["@allowx", "@allowy"] });
bl = await blocklist();
bl.channels[UC_A].mode === "exceptWhitelist" && bl.channels["@chanb"].mode === "exceptWhitelist" && bl.channels[UC_C].mode === "full"
  ? ok("SET_CHANNEL_MODE takes ids and touches only those")
  : fail("bulk mode: " + JSON.stringify(Object.values(bl.channels).map((e) => e.mode)));
bl.videos.vvvvvvvvvv1.hidden && bl.videos.vvvvvvvvvv2.hidden
  ? ok("SET_ENTRY_HIDDEN takes ids")
  : fail("bulk hide: " + JSON.stringify(bl.videos));
bl.allowlist["@allowx"] && bl.allowlist["@allowy"]
  ? ok("ALLOW_CHANNEL takes ids in one write")
  : fail("bulk allow: " + JSON.stringify(bl.allowlist));
await msg({ type: "SET_ENTRY_HIDDEN", kind: "video", ids: ["vvvvvvvvvv1", "vvvvvvvvvv2"], hidden: false });

// ---- 3. DELETE_DATA + restore by stamp ----
const d1 = await msg({ type: "DELETE_DATA", channels: [UC_A], videos: ["vvvvvvvvvv1"] });
bl = await blocklist();
!bl.channels[UC_A] && !bl.videos.vvvvvvvvvv1 && d1.removed.channels === 1 && d1.removed.videos === 1
  ? ok("DELETE_DATA removes exactly the listed entries")
  : fail("delete listed: " + JSON.stringify(d1));
const tombs = (await p.evaluate(() => chrome.storage.local.get("bt_tombstones"))).bt_tombstones || {};
tombs["channel:" + UC_A] && tombs["video:vvvvvvvvvv1"]
  ? ok("…and tombstones them so the sync merge propagates it")
  : fail("no tombstones: " + JSON.stringify(tombs));
// Another removal lands on top, so restoring by index 0 would undo the wrong one.
const d2 = await msg({ type: "UNBLOCK_VIDEO", id: "vvvvvvvvvv2" });
await msg({ type: "RESTORE_UNBLOCK", ts: d1.undoTs });
bl = await blocklist();
bl.channels[UC_A] && bl.channels[UC_A].mode === "exceptWhitelist" && bl.videos.vvvvvvvvvv1 && !bl.videos.vvvvvvvvvv2
  ? ok("RESTORE_UNBLOCK {ts} restores that record (mode intact), not the newest one")
  : fail("restore by ts: " + JSON.stringify({ ch: bl.channels[UC_A], v: Object.keys(bl.videos) }));
await msg({ type: "RESTORE_UNBLOCK", ts: d2.undoTs });

// keywords + never-block go in the same undo record
await p.evaluate(() =>
  chrome.storage.sync.set({ bt_keywords: { list: [{ p: "foo", re: false }, { p: "ba+r", re: true }], ts: Date.now(), durMinSec: 30, durMaxSec: 0, commentLimit: 20 } })
);
const d3 = await msg({ type: "DELETE_DATA", keywords: true, allowlist: true });
let kw = (await p.evaluate(() => chrome.storage.sync.get("bt_keywords"))).bt_keywords;
bl = await blocklist();
kw.list.length === 0 && kw.durMinSec === 30 && Object.keys(bl.allowlist).length === 0
  ? ok("DELETE_DATA clears keywords (length rule kept) and the never-block list")
  : fail("keyword/allow delete: " + JSON.stringify({ kw, allow: bl.allowlist }));
await msg({ type: "RESTORE_UNBLOCK", ts: d3.undoTs });
kw = (await p.evaluate(() => chrome.storage.sync.get("bt_keywords"))).bt_keywords;
bl = await blocklist();
kw.list.length === 2 && bl.allowlist["@allowx"]
  ? ok("…and the undo brings both back")
  : fail("keyword/allow restore: " + JSON.stringify({ kw, allow: bl.allowlist }));

// ---- 4. backup round trip through the UI ----
await p.reload();
await p.waitForTimeout(800);
// flip one switch so the backup has something non-default to restore
await p.evaluate(() => chrome.storage.sync.set({ bt_settings: { removeRelated: false } }));
const before = await blocklist();
await p.locator('.page-tab[data-page="data"]').click();
const [download] = await Promise.all([p.waitForEvent("download", { timeout: 5000 }), p.click("#export-btn")]);
const backup = JSON.parse(readFileSync(await download.path(), "utf8"));
backup.format === "xrntube-backup" &&
Object.keys(backup.channels).length === Object.keys(before.channels).length &&
backup.keywords.list.length === 2 &&
backup.allowlist["@allowx"] &&
backup.settings.removeRelated === false
  ? ok(`backup holds channels, videos, keywords, never-block and switches (${download.suggestedFilename()})`)
  : fail("backup contents: " + JSON.stringify(Object.keys(backup)));

// wipe, via the guarded button
await p.click("#danger-all");
await p.waitForSelector("#modal:not([hidden])");
(await p.locator("#modal-confirm").isDisabled())
  ? ok("“Delete everything” stays disabled until the word is typed")
  : fail("Delete everything confirm was enabled without typing");
await p.fill("#modal-body input", "delete");
await p.click("#modal-confirm");
await p.waitForTimeout(800);
await p.evaluate(() => chrome.storage.sync.set({ bt_settings: {} }));
bl = await blocklist();
kw = (await p.evaluate(() => chrome.storage.sync.get("bt_keywords"))).bt_keywords;
Object.keys(bl.channels).length === 0 && Object.keys(bl.videos).length === 0 && kw.list.length === 0 && Object.keys(bl.allowlist).length === 0
  ? ok("Delete everything empties channels, videos, keywords and never-block")
  : fail("wipe left things behind");

// restore from the file
await p.setInputFiles("#import-input", { name: "backup.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(backup)) });
await p.waitForSelector("#modal:not([hidden])");
const planRows = await p.locator("#modal-body .plan > li").count();
planRows >= 5
  ? ok(`import preview lists ${planRows} parts to choose from`)
  : fail("import preview rows: " + planRows);
await p.click("#modal-confirm");
await p.waitForTimeout(1500);
bl = await blocklist();
kw = (await p.evaluate(() => chrome.storage.sync.get("bt_keywords"))).bt_keywords;
const settings = (await p.evaluate(() => chrome.storage.sync.get("bt_settings"))).bt_settings;
Object.keys(bl.channels).length === Object.keys(before.channels).length &&
Object.keys(bl.videos).length === Object.keys(before.videos).length &&
bl.channels["@chanb"].ucid === UC_B &&
bl.channels[UC_A].mode === "exceptWhitelist" &&
kw.list.length === 2 &&
kw.commentLimit === 20 &&
bl.allowlist["@allowx"] &&
settings.removeRelated === false
  ? ok("importing the backup restores all of it — identities, modes, keywords, limits, never-block, switches")
  : fail("round trip lost something: " + JSON.stringify({ ch: Object.keys(bl.channels), kw, settings }));

// ---- 5. per-row Delete + Undo toast ----
await p.locator('.page-tab[data-page="blocklist"]').click();
await p.waitForTimeout(300);
const row = p.locator(`#channel-list .channel-row[data-id="${UC_C}"]`);
await row.locator(".unblock-btn").click();
await p.waitForTimeout(800);
bl = await blocklist();
const goneNow = !bl.channels[UC_C];
await p.locator(".toast button", { hasText: "Undo" }).first().click();
await p.waitForTimeout(800);
bl = await blocklist();
goneNow && bl.channels[UC_C] && bl.channels[UC_C].subs === "3K"
  ? ok("row Delete removes the channel and the toast's Undo puts it back whole")
  : fail(`row delete/undo: deleted=${goneNow} back=${JSON.stringify(bl.channels[UC_C])}`);

// ---- 6. what pasted text is read as ----
const parsed = await p.evaluate(() =>
  parseTargets(
    "@SomeOne https://www.youtube.com/@Other/videos UCdddddddddddddddddddddd, https://youtu.be/abcdefghijk " +
      "https://www.youtube.com/watch?v=zzzzzzzzzzz&ab_channel=X https://www.youtube.com/c/Legacy what"
  )
);
JSON.stringify(parsed.channels) === JSON.stringify(["@someone", "@other", "UCdddddddddddddddddddddd"]) &&
JSON.stringify(parsed.videos) === JSON.stringify(["abcdefghijk", "zzzzzzzzzzz"]) &&
parsed.unknown.length === 2
  ? ok("pasted text: handles, channel links, UC ids, video links — /c/ links and junk reported, never guessed")
  : fail("parseTargets: " + JSON.stringify(parsed));

// ---- 7. the age rule saves as you go ----
// It used to need a separate Save click after ticking the box; a rule ticked
// and never saved looked set while blocking nothing.
await p.locator('.page-tab[data-page="blocklist"]').click();
const rowA = () => p.locator(`#channel-list .channel-row[data-id="${UC_A}"]`);
await rowA().locator(".row-more-btn").click();
await rowA().locator("details.whitelist-details > summary").click();
await rowA().locator(".age-rule input[type=checkbox]").check();
await p.waitForTimeout(600);
const ageAfterTick = (await blocklist()).channels[UC_A].blockOlderThanDays;
await rowA().locator(".age-days").fill("1");
await rowA().locator(".age-days").press("Tab");
await p.waitForTimeout(600);
const ageAfterEdit = (await blocklist()).channels[UC_A].blockOlderThanDays;
await rowA().locator(".age-rule input[type=checkbox]").uncheck();
await p.waitForTimeout(600);
const ageAfterUntick = (await blocklist()).channels[UC_A].blockOlderThanDays;
ageAfterTick === 7 && ageAfterEdit === 1 && !ageAfterUntick
  ? ok("age rule: ticking saves it (7), editing the days saves (1), unticking clears it")
  : fail(`age rule saves: tick=${ageAfterTick} edit=${ageAfterEdit} untick=${ageAfterUntick}`);

// ---- 8. delete the channels the lookup couldn't use ----
// One of each: gone, looked up but failed, live but hiding its count, not
// looked up yet, and healthy. Only the first two are pre-selected; the
// not-yet-looked-up one must never be offered at all.
await msg({ type: "DELETE_DATA", channels: "all", videos: "all" });
const C = (n) => "UC" + String(n).padStart(22, "c");
await msg({
  type: "IMPORT_BLOCKLIST",
  channels: {
    [C(1)]: stamped({ name: "Gone one", gone: true, subs: "n/a" }),
    [C(2)]: stamped({ name: "Failed one" }), // looked up: no count, no @handle
    [C(3)]: stamped({ name: "Hidden one", subs: "hidden", handle: "@hiddenone" }),
    [C(4)]: { name: "Pending one", ts: now, mode: "full", whitelist: {} }, // never looked up
    [C(5)]: stamped({ name: "Healthy one", subs: "1.2M", handle: "@healthyone" })
  },
  videos: {}
});
await p.waitForTimeout(600);
await p.click("#bl-menu-btn");
await p.click("#clean-failed-btn");
await p.waitForSelector("#modal:not([hidden])");
const offered = await p.evaluate(() =>
  [...document.querySelectorAll("#modal-body .plan > li")].map((li) => ({
    title: li.querySelector(".plan-title").textContent,
    checked: li.querySelector("input").checked
  }))
);
JSON.stringify(offered) ===
JSON.stringify([
  { title: "Gone — 1", checked: true },
  { title: "Lookup failed — 1", checked: true },
  { title: "Hide their sub count — 1", checked: false }
])
  ? ok("cleanup offers gone + failed (pre-selected) and hidden-count (opt-in), never a not-yet-looked-up one")
  : fail("cleanup groups: " + JSON.stringify(offered));
await p.click("#modal-confirm");
await p.waitForTimeout(800);
bl = await blocklist();
const left = Object.keys(bl.channels).sort();
JSON.stringify(left) === JSON.stringify([C(3), C(4), C(5)].sort())
  ? ok("…and deletes exactly the selected groups")
  : fail("left after cleanup: " + JSON.stringify(left));
await p.locator(".toast button", { hasText: "Undo" }).first().click();
await p.waitForTimeout(800);
Object.keys((await blocklist()).channels).length === 5
  ? ok("…and Undo brings them back")
  : fail("undo after cleanup didn't restore");

// ---- 9. one channel stored twice is folded into one once it's paired ----
// "@dupchan" (video-only, blocked first) and its UC id (a full block, with a
// newer sub count) sit side by side until something links them. An import that
// reveals @dupchan's UC id must fold them: the earlier entry survives, the
// stricter mode wins, the newer count and both identities are kept, and the
// folded key gets a tombstone so other devices drop it too.
await msg({ type: "DELETE_DATA", channels: "all", videos: "all" });
const DUP_UC = "UCdup" + "x".repeat(19);
await msg({
  type: "IMPORT_BLOCKLIST",
  channels: {
    "@dupchan": { name: "Dup", ts: 1000, mode: "exceptWhitelist", whitelist: { vvvvvvvvvv1: "kept" }, subs: "1K", subsAt: 1000, subsV: SUBS_V },
    [DUP_UC]: { name: "", ts: 2000, mode: "full", subs: "5K", subsAt: 2000, subsV: SUBS_V }
  },
  videos: {}
});
const beforeFold = Object.keys((await blocklist()).channels).length;
const foldRes = await msg({ type: "IMPORT_BLOCKLIST", channels: { "@dupchan": { ucid: DUP_UC } }, videos: {} });
const folded = (await blocklist()).channels;
const dupTombs = (await p.evaluate(() => chrome.storage.local.get("bt_tombstones"))).bt_tombstones || {};
const f = folded["@dupchan"];
beforeFold === 2 && foldRes.folded === 1 && Object.keys(folded).length === 1 && f && f.ucid === DUP_UC
  ? ok("two entries for one channel fold into the earlier one once their identities are paired")
  : fail(`fold: before=${beforeFold} res=${JSON.stringify(foldRes)} left=${JSON.stringify(folded)}`);
f && f.mode === "full" && f.subs === "5K" && f.name === "Dup" && dupTombs["channel:" + DUP_UC]
  ? ok("…the stricter mode and newer sub count win, the name is kept, the folded key is tombstoned")
  : fail("fold result: " + JSON.stringify(f) + " tomb=" + !!dupTombs["channel:" + DUP_UC]);

errs.length === 0 ? ok("no options-page errors") : fail("page errors: " + errs.join(" | "));
swErr.length === 0 ? ok("no service worker errors") : fail("SW errors: " + swErr.join(" | "));
await ctx.close();
console.log("\nDONE");
