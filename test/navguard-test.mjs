import { chromium } from "playwright";

// The navigation guard: can a blocked channel still be *reached*?
//
// Every case here was a real hole. The two that prompted this file:
//   - a blocked channel's video played normally, because the guard only ran
//     at blocklist-load (page not rendered yet) and on "yt-navigate-finish"
//     (which a fresh, non-SPA load need not fire) — and never again;
//   - the redirect used `location.href = …`, which leaves the blocked URL in
//     session history, so Back went straight back to it.
//
// Scenarios that need a *signed-in* account (a real Subscriptions feed) or a
// second browser engine are out of scope, as everywhere else in this suite.

const EXT_PATH = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const HANDLE = "@mkbhd";
const UCID = "UCBJycsmduvYEL83R_U4JriQ";
const SAFE = "/feed/subscriptions";

const ctx = await chromium.launchPersistentContext(`/tmp/bt-test-${process.pid}-${Math.random().toString(36).slice(2)}`, {
  headless: false,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox"],
  viewport: { width: 1400, height: 900 }
});
const fail = (m) => {
  console.error("FAIL:", m);
  process.exitCode = 1;
};
const ok = (m) => console.log("ok:", m);

const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 15000 }));
const extId = sw.url().split("/")[2];
const ext = await ctx.newPage();
await ext.goto(`chrome-extension://${extId}/options/options.html`);
const send = (m) => ext.evaluate((mm) => new Promise((r) => chrome.runtime.sendMessage(mm, r)), m);

const page = await ctx.newPage();
const at = () => page.url();
const onSafe = () => at().includes(SAFE);
const go = async (url, ms = 8000) => {
  await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForTimeout(ms);
};

// A real, current video from the channel — hard-coding an id would rot.
await go(`https://www.youtube.com/${HANDLE}/videos`, 6000);
const VID = await page.evaluate(() => {
  const ids = [...document.querySelectorAll('a[href*="/watch?v="]')]
    .map((a) => (a.getAttribute("href") || "").match(/[?&]v=([\w-]{11})/)?.[1])
    .filter(Boolean);
  return ids[0] || null;
});
if (!VID) {
  console.error("FAIL: could not find a video on the channel page (YouTube markup changed?)");
  process.exitCode = 1;
  await ctx.close();
  process.exit();
}
// One of the channel's playlists, grabbed now — once the channel is blocked
// its /playlists tab bounces, so it can't be scraped later. Fetched from the
// page (a youtube.com origin) rather than with a bare fetch from Node.
const PLID = await page.evaluate(async () => {
  const r = await fetch("https://www.youtube.com/@mkbhd/playlists");
  const t = await r.text();
  return (t.match(/"playlistId":"(PL[\w-]{16,})"/) || [])[1] || null;
});

// NOTE: IMPORT_BLOCKLIST is merge-only — it has no "replace" mode — and
// addEntry() is a no-op for an already-blocked id, so re-blocking with a
// different mode does NOT change the mode. Clearing state between phases
// therefore has to go through UNBLOCK_CHANNEL, and a mode change through
// SET_CHANNEL_MODE. Getting this wrong makes the soft-mode assertion below
// silently test a still-FULL entry.
const clear = async () => {
  await send({ type: "UNBLOCK_CHANNEL", id: HANDLE });
  await send({ type: "DISALLOW_CHANNEL", id: HANDLE });
  await ext.waitForTimeout(600);
};

await clear();
await send({ type: "BLOCK_CHANNEL", id: HANDLE, name: "MKBHD", mode: "full" });
// BLOCK_CHANNEL kicks off a background identity fetch (handle <-> UC id) that
// the /channel/UC… case below depends on.
await ext.waitForTimeout(7000);

const entry = (await send({ type: "GET_BLOCKLIST" })).channels[HANDLE] || {};
entry.ucid === UCID
  ? ok("blocking by @handle resolves and stores the channel's UC id")
  : fail(`BLOCK_CHANNEL stored ucid=${entry.ucid || "none"}, expected ${UCID}`);

// ---- the channel's own page, by every URL shape ----
for (const [what, url] of [
  ["/@handle", `https://www.youtube.com/${HANDLE}`],
  ["/@handle/videos", `https://www.youtube.com/${HANDLE}/videos`],
  ["/channel/UC… (blocked by handle)", `https://www.youtube.com/channel/${UCID}`],
  ["legacy /c/<name>", "https://www.youtube.com/c/mkbhd"]
]) {
  await go(url);
  onSafe() ? ok(`blocked channel unreachable via ${what}`) : fail(`${what} still loads: ${at()}`);
}

// ---- the channel's videos, by every URL shape ----
for (const [what, url] of [
  ["watch?v=", `https://www.youtube.com/watch?v=${VID}`],
  ["watch?v=…&list=", `https://www.youtube.com/watch?v=${VID}&list=PLbpi6ZahtOH6Blw3RGYpWkSByi_T7Rygb`],
  ["/live/<id>", `https://www.youtube.com/live/${VID}`],
  ["/embed/<id>", `https://www.youtube.com/embed/${VID}`]
]) {
  await go(url, 9000);
  onSafe() ? ok(`blocked channel's video unreachable via ${what}`) : fail(`${what} still plays: ${at()}`);
}

// ---- a playlist the blocked channel owns ----
// The owner byline here lives in `yt-page-header-renderer`; the legacy
// ytd-playlist-header-renderer / -sidebar-primary-info-renderer tags this
// used to rely on no longer render, which left these pages reachable.
if (PLID) {
  await go(`https://www.youtube.com/playlist?list=${PLID}`, 9000);
  onSafe()
    ? ok("blocked channel's playlist page is unreachable")
    : fail(`playlist page of a blocked channel still loads: ${at()}`);
} else {
  console.log("ok: (skipped) no playlist id found for the channel");
}

// ---- Back must not land back on the blocked page ----
await go("https://www.youtube.com/results?search_query=tech+review", 5000);
await go(`https://www.youtube.com/watch?v=${VID}`, 9000);
if (!onSafe()) fail("precondition: the video was not bounced, so Back can't be tested");
await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
await page.waitForTimeout(5000);
at().includes(VID)
  ? fail(`Back returned to the blocked video (${at()}) — the bounce must use location.replace()`)
  : ok("Back after a bounce does not return to the blocked video");

// ---- blocking while the video is already open ----
await clear();
await go(`https://www.youtube.com/watch?v=${VID}`, 8000);
if (onSafe()) fail("precondition: video was bounced before it was blocked");
await send({ type: "BLOCK_CHANNEL", id: HANDLE, name: "MKBHD", mode: "full" });
await page.waitForTimeout(6000);
onSafe()
  ? ok("blocking a channel while watching its video leaves the page")
  : fail(`still on the video after blocking its channel: ${at()}`);

// ---- and the things that must STILL be reachable ----
await clear();
await send({ type: "BLOCK_CHANNEL", id: HANDLE, name: "MKBHD", mode: "exceptWhitelist" });
await ext.waitForTimeout(5000);
const softMode = ((await send({ type: "GET_BLOCKLIST" })).channels[HANDLE] || {}).mode;
if (softMode !== "exceptWhitelist") fail(`precondition: entry is mode=${softMode}, not exceptWhitelist`);
await go(`https://www.youtube.com/${HANDLE}`, 7000);
!onSafe()
  ? ok("EXCEPT_WHITELIST channel's own page is still reachable")
  : fail("soft-blocked channel page was redirected — that mode must leave it alone");

await clear();
await send({ type: "BLOCK_CHANNEL", id: HANDLE, name: "MKBHD", mode: "full" });
await send({ type: "ALLOW_CHANNEL", id: HANDLE });
await ext.waitForTimeout(4000);
await go(`https://www.youtube.com/watch?v=${VID}`, 8000);
!onSafe()
  ? ok("allow-listed channel's video plays despite a full block")
  : fail("allow-list did not override the nav guard");
await send({ type: "DISALLOW_CHANNEL", id: HANDLE });

await go("https://www.youtube.com/watch?v=dQw4w9WgXcQ", 8000);
!onSafe()
  ? ok("an unrelated channel's video is untouched")
  : fail("bounced off a video whose channel is not blocked (false positive)");

await ctx.close();
