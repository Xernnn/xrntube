import { chromium } from "playwright";
const EXT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const ctx = await chromium.launchPersistentContext(`/tmp/bt-test-${process.pid}-${Math.random().toString(36).slice(2)}`, {
  headless: false,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--headless=new", "--no-sandbox"],
});
const fail = (m) => { console.error("FAIL:", m); process.exitCode = 1; };
const ok = (m) => console.log("ok:", m);
let sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 10000 }));
const extId = sw.url().split("/")[2];

// --- watch page: no horizontal overflow, player fills the width ---
for (const vw of [1920, 1440, 1200]) {
  const p = await ctx.newPage();
  await p.setViewportSize({ width: vw, height: 900 });
  await p.goto("https://www.youtube.com/watch?v=aqz-KE-bpKQ", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(7000);
  const r = await p.evaluate(() => {
    const de = document.documentElement;
    const prim = document.querySelector("ytd-watch-flexy #primary");
    const player = document.querySelector("ytd-watch-flexy #player-container, ytd-watch-flexy #player");
    const pr = prim && prim.getBoundingClientRect();
    const pl = player && player.getBoundingClientRect();
    return {
      overflowX: de.scrollWidth - de.clientWidth,
      primRight: pr ? Math.round(pr.right) : null,
      playerRight: pl ? Math.round(pl.right) : null,
      innerW: window.innerWidth,
      appOverflowX: getComputedStyle(document.querySelector("ytd-app")).overflowX,
    };
  });
  await p.close();
  console.log(`   vw=${vw}:`, JSON.stringify(r));
  r.overflowX <= 1
    ? ok(`vw=${vw}: no horizontal page overflow (${r.overflowX}px)`)
    : fail(`vw=${vw}: page overflows by ${r.overflowX}px (arrow keys would pan)`);
  // player right edge should be within ~2px of the primary column's right edge (gap trimmed)
  if (r.primRight != null && r.playerRight != null) {
    Math.abs(r.primRight - r.playerRight) <= 20
      ? ok(`vw=${vw}: player fills the column (right-edge gap ~${Math.abs(r.primRight - r.playerRight)}px)`)
      : fail(`vw=${vw}: ${r.primRight - r.playerRight}px gap between player and column edge`);
  }
}

// --- search autocomplete hidden by default; back when toggled off ---
const opt = await ctx.newPage();
await opt.goto(`chrome-extension://${extId}/options/options.html`);
await opt.waitForTimeout(300);
await opt.locator('.page-tab[data-page="settings"]').click();
await opt.waitForTimeout(150);
const nToggles = await opt.locator("#settings-list .switch").count();
nToggles === 33 ? ok("33 feature toggles now") : fail("toggle count: " + nToggles);

const typeSearch = async (p) => {
  await p.goto("https://www.youtube.com/", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(3500);
  const box = await p.$('input[name="search_query"], ytd-searchbox input, input#search');
  if (!box) return null;
  await box.click();
  await box.type("music", { delay: 90 });
  await p.waitForTimeout(2200);
  return p.evaluate(() => {
    const c = document.querySelector(".ytSearchboxComponentSuggestionsContainer, ytd-search-suggestions-section, tp-yt-paper-listbox#suggestions");
    if (!c) return { present: false };
    return { present: true, display: getComputedStyle(c).display, h: Math.round(c.getBoundingClientRect().height) };
  });
};

const s1 = await (async () => { const p = await ctx.newPage(); const r = await typeSearch(p); await p.close(); return r; })();
console.log("   suggestions (default):", JSON.stringify(s1));
(!s1 || !s1.present || s1.display === "none" || s1.h < 4)
  ? ok("search autocomplete hidden by default")
  : fail("autocomplete still visible: " + JSON.stringify(s1));

// Address the toggle by key, never by position — inserting a setting used
// to silently re-point this at a different switch, and the failure then
// surfaced as "autocomplete did not return".
await opt.locator('#settings-list .switch[data-key="hideSearchSuggestions"] .slider').click();
await opt.waitForFunction(() => chrome.storage.sync.get("bt_settings").then((r) => r.bt_settings && r.bt_settings.hideSearchSuggestions === false), null, { timeout: 3000 });
const s2 = await (async () => { const p = await ctx.newPage(); const r = await typeSearch(p); await p.close(); return r; })();
console.log("   suggestions (toggle off):", JSON.stringify(s2));
(s2 && s2.present && s2.display !== "none" && s2.h > 4)
  ? ok("toggle off -> autocomplete comes back")
  : fail("autocomplete did not return: " + JSON.stringify(s2));

await ctx.close();
console.log("\nDONE");
