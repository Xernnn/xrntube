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

const opt = await ctx.newPage();
opt.on("pageerror", (e) => fail("options pageerror: " + e.message));
await opt.goto(`chrome-extension://${extId}/options/options.html`);
await opt.waitForLoadState("domcontentloaded");
await opt.waitForTimeout(300);
await opt.locator(".page-tab[data-page='settings']").click();
await opt.waitForTimeout(150);

// --- 1. every toggle renders, all on by default ---
const nSwitches = await opt.locator("#settings-list .switch").count();
const nChecked = await opt.locator("#settings-list .switch input:checked").count();
nSwitches === 39 && nChecked === 38
  ? ok("39 toggles render; 38 on by default (blockInEmbeds is opt-in)")
  : fail(`39 toggles: ${nSwitches} rendered, ${nChecked} checked`);

const setToggle = async (key, on) => {
  // A key may name one switch or several — the coarse toggles this suite used
  // to flip are now groups of per-element switches (see SETTING_GROUPS).
  for (const k of [].concat(key)) {
    const cb = opt.locator(`#settings-list .switch[data-key="${k}"] input`);
    if ((await cb.isChecked()) !== on) await opt.locator(`#settings-list .switch[data-key="${k}"] .slider`).click();
    await opt.waitForFunction(
      ([kk, v]) => chrome.storage.sync.get("bt_settings").then((r) => r.bt_settings && r.bt_settings[kk] === v),
      [k, on],
      { timeout: 3000 }
    );
  }
};

// --- 2. persistence to chrome.storage.sync ---
await setToggle("redirectHomepage", false);
const stored = await opt.evaluate(() => chrome.storage.sync.get("bt_settings"));
stored.bt_settings && stored.bt_settings.redirectHomepage === false
  ? ok("toggle writes bt_settings to storage.sync")
  : fail("not persisted: " + JSON.stringify(stored));

// --- 3. background drops the DNR home rule when redirectHomepage is off ---
await opt.waitForTimeout(400);
let rules = await sw.evaluate(() => chrome.declarativeNetRequest.getDynamicRules());
let ids = rules.map((r) => r.id);
!ids.includes(900001)
  ? ok("DNR home rule (900001) removed when redirectHomepage off")
  : fail("home rule still present: " + JSON.stringify(ids));
await setToggle("redirectHomepage", true);
await opt.waitForTimeout(400);
rules = await sw.evaluate(() => chrome.declarativeNetRequest.getDynamicRules());
rules.map((r) => r.id).includes(900001)
  ? ok("DNR home rule restored when redirectHomepage back on")
  : fail("home rule not restored");

// --- 4. logoToSubscriptions off -> masthead logo href stays "/" ---
await setToggle("logoToSubscriptions", false);
const yt1 = await ctx.newPage();
await yt1.goto("https://www.youtube.com/feed/subscriptions", { waitUntil: "domcontentloaded" });
await yt1.waitForTimeout(5000);
const href = await yt1.evaluate(() => {
  const a = document.querySelector("ytd-masthead a#logo, #masthead a#logo, ytd-topbar-logo-renderer a");
  return a ? a.getAttribute("href") : "(none)";
});
await yt1.close();
href === "/" ? ok('logo href left as "/" when toggle off') : fail("logo href = " + href);
await setToggle("logoToSubscriptions", true);

// --- 4b. logoToSubscriptions on -> a logo click goes to Subscriptions in ONE
// in-app hop. The old href-only version also ended on /feed/subscriptions,
// but by starting toward home and reloading the page — so the assertion that
// matters is "no document load", not the final URL.
const yt1b = await ctx.newPage();
await yt1b.goto("https://www.youtube.com/results?search_query=mkbhd", { waitUntil: "domcontentloaded" });
await yt1b.waitForTimeout(5000);
const logoHref = await yt1b.locator("ytd-masthead a#logo").first().getAttribute("href");
const docLoads = [];
yt1b.on("request", (r) => {
  if (r.resourceType() === "document" && r.frame() === yt1b.mainFrame()) docLoads.push(r.url());
});
await yt1b.evaluate(() => (window.__btSamePage = 1));
await yt1b.locator("ytd-masthead a#logo").first().click();
await yt1b.waitForTimeout(4000);
const samePage = await yt1b.evaluate(() => window.__btSamePage === 1).catch(() => false);
/\/feed\/subscriptions/.test(yt1b.url()) && samePage && docLoads.length === 0
  ? ok(`logo click → Subscriptions in one in-app hop (href ${logoHref}, no reload)`)
  : fail(`logo click: url=${yt1b.url()} samePage=${samePage} docLoads=${JSON.stringify(docLoads)} href=${logoHref}`);
await yt1b.close();

// --- 5. removeShorts off -> Shorts shelves survive on a search page ---
await setToggle(["shortsFeedTiles", "shortsPlayer", "shortsChannelTab"], false);
const yt2 = await ctx.newPage();
await yt2.goto("https://www.youtube.com/results?search_query=news+shorts", { waitUntil: "domcontentloaded" });
await yt2.waitForTimeout(6000);
const shortsWhenOff = await yt2.evaluate(() =>
  document.querySelectorAll("ytd-reel-shelf-renderer, ytm-shorts-lockup-view-model-v2, grid-shelf-view-model").length
);
await yt2.close();
shortsWhenOff > 0
  ? ok(`removeShorts off: ${shortsWhenOff} Shorts element(s) left in place`)
  : console.log("   (no Shorts on that search page right now — can't prove the negative, skipping)");

await setToggle(["shortsFeedTiles", "shortsPlayer", "shortsChannelTab"], true);
const yt3 = await ctx.newPage();
await yt3.goto("https://www.youtube.com/results?search_query=news+shorts", { waitUntil: "domcontentloaded" });
await yt3.waitForTimeout(9000);
const diag = await yt3.evaluate(() => {
  const style = document.getElementById("bt-instant-hide");
  const survivors = [...document.querySelectorAll("ytd-reel-shelf-renderer, ytm-shorts-lockup-view-model-v2")];
  return {
    styleHasShortsBlock: !!style && /reel-shelf-renderer/.test(style.textContent),
    styleLen: style ? style.textContent.length : 0,
    count: survivors.length,
    sample: survivors.slice(0, 4).map((s) => ({
      tag: s.tagName.toLowerCase(),
      connected: s.isConnected,
      display: getComputedStyle(s).display,
      text: (s.textContent || "").trim().slice(0, 50)
    }))
  };
});
await yt3.close();
console.log("   diag:", JSON.stringify(diag, null, 1));
diag.count === 0
  ? ok("removeShorts on: 0 Shorts shelves/tiles remain")
  : fail(`${diag.count} Shorts elements survived with the toggle on`);

// --- 6. reset button ---
await opt.locator("#settings-reset").click();
await opt.waitForTimeout(200);
const afterReset = await opt.evaluate(() => chrome.storage.sync.get("bt_settings"));
// Reset restores DEFAULTS, which is not the same as "everything on":
// blockInEmbeds is opt-in and must come back off.
const resetSettings = afterReset.bt_settings;
const offAfterReset = Object.entries(resetSettings).filter(([, v]) => v !== true).map(([k]) => k);
JSON.stringify(offAfterReset) === JSON.stringify(["blockInEmbeds"])
  ? ok("Reset to defaults -> every toggle on except the opt-in blockInEmbeds")
  : fail(`reset didn't restore defaults, off after reset: ${JSON.stringify(offAfterReset)}`);

await opt.waitForTimeout(300);
if (swErr.length) fail("SW console errors:\n" + swErr.join("\n"));
else ok("no service worker console errors");

await ctx.close();
console.log("\nDONE");
