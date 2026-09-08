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

const opt = await ctx.newPage();
await opt.goto(`chrome-extension://${extId}/options/options.html`);
await opt.waitForLoadState("domcontentloaded");
await opt.waitForTimeout(300);
await opt.locator(".page-tab[data-page='settings']").click();
await opt.waitForTimeout(150);

// 10 toggles now, all on
const n = await opt.locator("#settings-list .switch input:checked").count();
n === 12 ? ok("12 toggles, all on by default") : fail(`checked toggles: ${n}`);

const KEYS = ["removeShorts","redirectHomepage","logoToSubscriptions","cleanSidebar","cleanMasthead","removeRelated","removeEndScreen","hideVoiceSearch","accountButtonOnHover","hideVideoActions"];
const setToggle = async (key, on) => {
  const i = KEYS.indexOf(key);
  const cb = opt.locator("#settings-list .switch input").nth(i);
  if ((await cb.isChecked()) !== on) await opt.locator("#settings-list .switch .slider").nth(i).click();
  await opt.waitForFunction(([k, v]) => chrome.storage.sync.get("bt_settings").then((r) => r.bt_settings && r.bt_settings[k] === v), [key, on], { timeout: 3000 });
};

// ---- 1. voice search button (masthead, works signed out) ----
const yt = await ctx.newPage();
await yt.goto("https://www.youtube.com/feed/subscriptions", { waitUntil: "domcontentloaded" });
await yt.waitForTimeout(6000);
const voiceOn = await yt.evaluate(() => {
  const el = document.querySelector("#voice-search-button");
  return { exists: !!el, display: el ? getComputedStyle(el).display : null };
});
(voiceOn.exists && voiceOn.display === "none")
  ? ok("voice-search button hidden by default")
  : fail("voice-search not hidden: " + JSON.stringify(voiceOn));

await setToggle("hideVoiceSearch", false);
await yt.reload({ waitUntil: "domcontentloaded" });
await yt.waitForTimeout(6000);
const voiceOff = await yt.evaluate(() => {
  const el = document.querySelector("#voice-search-button");
  return el ? getComputedStyle(el).display : "(gone)";
});
voiceOff !== "none" ? ok(`toggle off -> voice-search visible again (${voiceOff})`) : fail("still hidden after toggle off");
await setToggle("hideVoiceSearch", true);
await yt.close();

// ---- 2. account-button CSS rule present/absent (visual needs a signed-in acct) ----
const styleHas = async (needle) => {
  const p = await ctx.newPage();
  await p.goto("https://www.youtube.com/feed/subscriptions", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(4000);
  const r = await p.evaluate((nd) => {
    const s = document.getElementById("bt-instant-hide");
    return !!s && s.textContent.includes(nd);
  }, needle);
  await p.close();
  return r;
};
(await styleHas("#avatar-btn")) ? ok("account-button hover CSS present by default") : fail("avatar-btn rule missing");
await setToggle("accountButtonOnHover", false);
!(await styleHas("#avatar-btn")) ? ok("toggle off -> avatar-btn rule dropped") : fail("avatar rule still there");
await setToggle("accountButtonOnHover", true);

// ---- 3. video action buttons on a watch page ----
const w = await ctx.newPage();
await w.goto("https://www.youtube.com/watch?v=aqz-KE-bpKQ", { waitUntil: "domcontentloaded" });
await w.waitForTimeout(8000);
const actOn = await w.evaluate(() => {
  const scope = document.querySelector("ytd-watch-metadata #actions");
  if (!scope) return { noScope: true };
  const q = (label) => {
    const els = [...scope.querySelectorAll("[aria-label]")].filter((e) => (e.getAttribute("aria-label") || "").toLowerCase() === label);
    return els.filter((e) => { const r = e.getBoundingClientRect(); return r.width > 2 && r.height > 2; }).length;
  };
  return {
    share: q("share"),
    save: q("save to playlist"),
    download: q("download"),
    more: q("more actions"),
    likeStillThere: [...scope.querySelectorAll("[aria-label]")].some((e) => /like this video/i.test(e.getAttribute("aria-label") || "")),
  };
});
console.log("   watch actions (ON):", JSON.stringify(actOn));
(actOn.share === 0 && actOn.save === 0 && actOn.download === 0 && actOn.more === 0 && actOn.likeStillThere)
  ? ok("Share/Save/Download/More gone from the watch action row; Like kept")
  : fail("video actions not fully hidden: " + JSON.stringify(actOn));

await setToggle("hideVideoActions", false);
await w.reload({ waitUntil: "domcontentloaded" });
await w.waitForTimeout(8000);
const actOff = await w.evaluate(() => {
  const scope = document.querySelector("ytd-watch-metadata #actions");
  const q = (label) => [...scope.querySelectorAll("[aria-label]")].filter((e) => (e.getAttribute("aria-label") || "").toLowerCase() === label).filter((e) => { const r = e.getBoundingClientRect(); return r.width > 2 && r.height > 2; }).length;
  return { share: q("share"), more: q("more actions") };
});
console.log("   watch actions (OFF):", JSON.stringify(actOff));
(actOff.share > 0 && actOff.more > 0) ? ok("toggle off -> Share + More back") : fail("actions not restored: " + JSON.stringify(actOff));
await w.close();

await ctx.close();
console.log("\nDONE");
