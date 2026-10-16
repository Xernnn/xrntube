import { chromium } from "playwright";

// The other half of layer 0: datalayer-test.mjs proves the FILTER is correct
// against synthetic responses; this proves it is actually WIRED UP in the
// shipped extension against live YouTube. They fail independently — the rule
// table can be perfect while the MAIN-world script never loads, and the DOM
// scrub would quietly cover for it, so every other test in the suite would
// still pass and nothing would tell you layer 0 was dead.
//
// What has to hold for this to pass:
//   - the manifest's `world: "MAIN"` entry loaded (and the browser honours it)
//   - content.js answered the hook's "hello" with a config
//   - the window.fetch hook fired on a real /youtubei/v1/search continuation,
//     the rule table matched live renderer shapes, and something was removed
//   - the popup's health line (GET_PAGE_HEALTH) reports exactly that
//
// Needs `?bt-debug`, which is what exposes window.__btDataLayer at all.

const EXT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const CH = "@mkbhd";
const SEARCH = "https://www.youtube.com/results?search_query=mkbhd+iphone&bt-debug";

const ctx = await chromium.launchPersistentContext(
  `/tmp/bt-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
  {
    headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--headless=new", "--no-sandbox"]
  }
);
const fail = (m) => {
  console.error("FAIL:", m);
  process.exitCode = 1;
};
const ok = (m) => console.log("ok:", m);

const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 10000 }));
const extId = sw.url().split("/")[2];
const ext = await ctx.newPage();
await ext.goto(`chrome-extension://${extId}/options/options.html`);
const send = (m) => ext.evaluate((mm) => chrome.runtime.sendMessage(mm), m);

// ---- the MAIN-world script loads, and installs both hooks ----
// Note the URL: https://www.youtube.com/?bt-debug loses its query on the way
// to the rendered document, so the probe has to use a page that keeps it.
{
  const probe = await ctx.newPage();
  const errs = [];
  probe.on("pageerror", (e) => errs.push(String(e).slice(0, 160)));
  await probe.goto(SEARCH, { waitUntil: "domcontentloaded" });
  await probe.waitForTimeout(7000);
  const world = await probe.evaluate(() => ({
    stats: window.__btDataLayer ?? null,
    hookGetter: !!(Object.getOwnPropertyDescriptor(window, "ytInitialData") || {}).get,
    fetchPatched: !/\[native code\]/.test(String(window.fetch)),
    xrnTube: typeof window.XrnTube
  }));
  await probe.close();

  // A content script throwing on startup is the failure mode that broke this
  // the first time: listing a shared file in both worlds meant the isolated
  // entry silently didn't get it, and content.js died with "Cannot
  // destructure property 'MSG' of 'self.XrnTube'". That is what this
  // assertion is for, so it matches that signature rather than "any uncaught
  // error" — live YouTube throws its own occasionally (seen: `ShadyDOM.patch
  // is not a function` from a half-loaded Polymer bundle, with every other
  // assertion here passing and no errors at all on a clean re-run, with or
  // without the extension). Anything else is printed, not failed on.
  const ours = errs.filter((e) => /XrnTube/i.test(e));
  if (errs.length && !ours.length) console.log("   (YouTube's own page errors, ignored):", JSON.stringify(errs));
  ours.length === 0
    ? ok("neither world threw a XrnTube error on startup")
    : fail(`XrnTube page errors: ${JSON.stringify(ours)}`);
  world.stats
    ? ok("MAIN-world page hook is loaded on youtube.com")
    : fail('window.__btDataLayer missing — the world:"MAIN" content script did not run');
  world.hookGetter && world.fetchPatched
    ? ok("both hooks installed (ytInitialData getter + window.fetch)")
    : fail(`hooks missing: ${JSON.stringify(world)}`);
  // The blocklist lives in the isolated world and never crosses. All that
  // goes over postMessage is a description of what YouTube itself just sent,
  // so nothing the page can read reveals what the user blocks.
  world.xrnTube === "undefined"
    ? ok("no XrnTube global is exposed to the page")
    : fail(`window.XrnTube is ${world.xrnTube} on the page`);
}

// ---- it filters a real search continuation ----
await send({ type: "BLOCK_CHANNEL", id: CH, name: "MKBHD", mode: "full" });
await send({ type: "REBROADCAST_BLOCKLIST" });

const p = await ctx.newPage();
await p.goto(SEARCH, { waitUntil: "domcontentloaded" });
await p.waitForTimeout(8000);

// Scrolling is what makes YouTube fetch /youtubei/v1/search continuations.
// The first paint comes from ytInitialData, which is a deliberate race
// against the blocklist arriving and so can't be asserted on.
for (let i = 0; i < 4; i += 1) {
  await p.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await p.waitForTimeout(2500);
}

const stats = await p.evaluate(() => (window.__btDataLayer ? { ...window.__btDataLayer } : null));
console.log("   __btDataLayer:", JSON.stringify(stats));
const tiles = await p.evaluate(() =>
  [...document.querySelectorAll("ytd-video-renderer, yt-lockup-view-model, ytd-rich-item-renderer")].filter(
    (t) => t.isConnected && getComputedStyle(t).display !== "none" && /\/@mkbhd\b/i.test(t.innerHTML)
  ).length
);
// What the popup's health line reads (GET_PAGE_HEALTH): the same evidence,
// asked of the content script the way the popup asks it.
const health = await ext.evaluate(async () => {
  const [tab] = await chrome.tabs.query({ url: "*://www.youtube.com/results*" });
  return tab ? chrome.tabs.sendMessage(tab.id, { type: "GET_PAGE_HEALTH" }, { frameId: 0 }) : null;
});
console.log("   GET_PAGE_HEALTH:", JSON.stringify(health));
health && health.hook && health.early > 0 && !health.degraded
  ? ok(`the popup's health line sees the early filter working (${health.early} removed before render, ${health.dom} after)`)
  : fail("page health: " + JSON.stringify(health));
await p.close();

if (!stats) {
  fail("no __btDataLayer on the search page");
} else {
  stats.responses > 0
    ? ok(`fetch hook saw ${stats.responses} /youtubei/v1 response(s)`)
    : fail("the fetch hook never fired — no search/browse responses were inspected");
  stats.candidates > 0
    ? ok(`rule table described ${stats.candidates} renderer(s) in live responses`)
    : fail("the rule table matched no renderers at all in a live response");
  stats.removed > 0
    ? ok(`data layer removed ${stats.removed} renderer(s) before render`)
    : fail("the hook fired and matched renderers but removed nothing");
}
tiles === 0 ? ok("no MKBHD tiles left on the page") : fail(`${tiles} MKBHD tiles still visible`);

await ctx.close();
console.log("\nDONE");
