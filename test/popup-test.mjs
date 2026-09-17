import { chromium } from "playwright";

// The popup, and the content-script contract it depends on.
//
// The popup renders one block button per channel GET_PAGE_TARGET returns, so
// that message returning a channel twice under its two identity formats would
// show two identical "Block channel: X" buttons. `getCurrentPageTarget()` takes
// a `withAliases` flag for exactly this reason — the nav guard wants every
// identity, the popup wants one row per real channel — and nothing else guards
// that split.
//
// The popup's own block buttons can't be driven here: it reads
// `chrome.tabs.query({active: true})`, and a popup opened as an ordinary
// Playwright page *is* the active tab. So the buttons are covered via the
// message they send, and the popup is checked for the states it can reach.

const EXT_PATH = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const HANDLE = "@mkbhd";
const UCID = "UCBJycsmduvYEL83R_U4JriQ";

const ctx = await chromium.launchPersistentContext(`/tmp/bt-test-${process.pid}-${Math.random().toString(36).slice(2)}`, {
  headless: false,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox"],
  viewport: { width: 1280, height: 900 }
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

// Seed a known blocklist so the popup's counters have something to report.
await send({ type: "IMPORT_BLOCKLIST", channels: { "@seedchan": { name: "Seed" } }, videos: { seedVideo1: { title: "v" } } });
await ext.waitForTimeout(600);

// ---- counters ----
const pop = await ctx.newPage();
const errs = [];
pop.on("pageerror", (e) => errs.push(String(e)));
await pop.goto(`chrome-extension://${extId}/popup/popup.html`);
await pop.waitForTimeout(1200);
const counts = await pop.evaluate(() => ({
  channels: document.getElementById("channel-count").textContent,
  videos: document.getElementById("video-count").textContent,
  noTarget: !document.getElementById("no-target").hidden
}));
counts.channels === "1" && counts.videos === "1"
  ? ok(`popup reports the real blocklist size (${counts.channels} channels, ${counts.videos} videos)`)
  : fail(`popup counters wrong: ${JSON.stringify(counts)}`);
// The active tab here is the popup itself, i.e. not YouTube — the honest
// "nothing to block from here" state.
counts.noTarget
  ? ok("popup shows the 'open a YouTube page' state when the tab isn't YouTube")
  : fail("popup did not fall back to the no-target state off YouTube");

// ---- "Manage blocklist" opens the options page ----
// openOptionsPage() focuses an already-open options tab rather than adding a
// second one, so close ours first — otherwise this passes or fails on whether
// the harness happened to leave one open.
await ext.close();
await pop.waitForTimeout(300);
await pop.click("#manage-btn");
await pop.waitForTimeout(2000);
ctx.pages().some((pg) => pg.url().includes("/options/options.html"))
  ? ok("'Manage blocklist' opens the options page")
  : fail("Manage blocklist did not open the options page");
errs.length === 0 ? ok("no popup script errors") : fail(`popup errors: ${errs[0]}`);
await pop.close();

// Re-open an options page to keep sending messages from.
const ext2 = await ctx.newPage();
await ext2.goto(`chrome-extension://${extId}/options/options.html`);
await ext2.waitForTimeout(500);

// ---- the contract the popup's buttons rely on ----
const yt = await ctx.newPage();
const pageTarget = async (url, ms = 9000) => {
  await yt.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
  await yt.waitForTimeout(ms);
  // Ask the content script in that tab, exactly as the popup does.
  return ext2.evaluate(
    () =>
      new Promise((resolve) => {
        chrome.tabs.query({}, (tabs) => {
          const t = tabs.find((x) => (x.url || "").includes("youtube.com"));
          if (!t) return resolve({ error: "no youtube tab" });
          chrome.tabs.sendMessage(t.id, { type: "GET_PAGE_TARGET" }, (r) =>
            resolve(chrome.runtime.lastError ? { error: chrome.runtime.lastError.message } : r)
          );
        });
      })
  );
};

const VID = await yt
  .goto(`https://www.youtube.com/${HANDLE}/videos`, { waitUntil: "domcontentloaded" })
  .then(() => yt.waitForTimeout(6000))
  .then(() =>
    yt.evaluate(() => {
      const ids = [...document.querySelectorAll('a[href*="/watch?v="]')]
        .map((a) => (a.getAttribute("href") || "").match(/[?&]v=([\w-]{11})/)?.[1])
        .filter(Boolean);
      return ids[0] || null;
    })
  )
  .catch(() => null);

if (VID) {
  const watch = await pageTarget(`https://www.youtube.com/watch?v=${VID}`);
  watch && watch.videoId === VID
    ? ok(`watch page reports its video id (${watch.videoId})`)
    : fail(`watch page target wrong: ${JSON.stringify(watch)}`);
  const keys = (watch && watch.channels ? watch.channels : []).map((c) => c.key);
  keys.length >= 1
    ? ok(`watch page reports its channel (${keys.join(", ")})`)
    : fail(`no channel found on the watch page: ${JSON.stringify(watch)}`);
  // The alias split: one row per real channel, never the same channel twice
  // under both identity formats.
  const lower = keys.map((k) => k.toLowerCase());
  new Set(lower).size === lower.length
    ? ok("no duplicate channel rows for the popup to render")
    : fail(`popup would render duplicate buttons: ${JSON.stringify(keys)}`);
  !(lower.includes(HANDLE) && lower.includes(UCID.toLowerCase()))
    ? ok("the same channel is not returned under both identity formats")
    : fail(`both identities returned to the popup: ${JSON.stringify(keys)}`);
}

// A channel page must resolve to exactly one channel — the one whose page it is.
const chan = await pageTarget(`https://www.youtube.com/${HANDLE}`);
const chanKeys = (chan && chan.channels ? chan.channels : []).map((c) => c.key);
chanKeys.length === 1 && chanKeys[0].toLowerCase() === HANDLE
  ? ok(`channel page reports exactly one channel (${chanKeys[0]})`)
  : fail(`channel page target wrong: ${JSON.stringify(chanKeys)}`);

const send2 = (m) => ext2.evaluate((mm) => new Promise((r) => chrome.runtime.sendMessage(mm, r)), m);
await send2({ type: "UNBLOCK_CHANNEL", id: "@seedchan" });
await send2({ type: "UNBLOCK_VIDEO", id: "seedVideo1" });
await ctx.close();
