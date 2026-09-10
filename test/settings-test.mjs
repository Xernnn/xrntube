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
nSwitches === 32 && nChecked === 32
  ? ok("32 toggles render, all on by default")
  : fail(`32 toggles: ${nSwitches} rendered, ${nChecked} checked`);

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
Object.values(afterReset.bt_settings).every((v) => v === true)
  ? ok("Reset to defaults -> all toggles true")
  : fail("reset didn't restore all: " + JSON.stringify(afterReset.bt_settings));

await opt.waitForTimeout(300);
if (swErr.length) fail("SW console errors:\n" + swErr.join("\n"));
else ok("no service worker console errors");

await ctx.close();
console.log("\nDONE");
