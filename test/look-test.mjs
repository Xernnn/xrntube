import { chromium } from "playwright";

// How the options page and the popup are put together, offline: the map has a
// spot for every switch and stays in step with the list both ways, a toggle keeps
// focus, a search makes room for its matches and still reads the descriptions the
// page doesn't show. Also what a palette or a phone breaks without an error: Sync's
// disconnected buttons, its address box, a long progress line, the menu strip, and
// the contrast of each pair of colours that's easy to get wrong.
//
// Needs the extension but not the network, and no blocklist at all.

const EXT_PATH = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const ctx = await chromium.launchPersistentContext(`/tmp/bt-test-${process.pid}-${Math.random().toString(36).slice(2)}`, {
  headless: false,
  viewport: { width: 1400, height: 1000 },
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox"]
});
const fail = (m) => {
  console.error("FAIL:", m);
  process.exitCode = 1;
};
const ok = (m) => console.log("ok:", m);
const check = (cond, m) => (cond ? ok(m) : fail(m));

const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 15000 }));
const extId = sw.url().split("/")[2];
const p = await ctx.newPage();
const errs = [];
p.on("pageerror", (e) => errs.push(String(e)));
const OPTIONS = `chrome-extension://${extId}/options/options.html`;
await p.goto(OPTIONS);
await p.waitForTimeout(500);
await p.click('.page-tab[data-page="settings"]');

const stored = (key) =>
  p.evaluate(async (k) => {
    const res = await chrome.storage.sync.get(self.XrnTube.SETTINGS_KEY);
    return self.XrnTube.resolveSettings(res[self.XrnTube.SETTINGS_KEY])[k];
  }, key);
const spot = (key) => p.locator(`[data-map="${key}"]`);
const listBox = (key) => p.locator(`.switch[data-key="${key}"] input`);

// ---- 1. the map covers every switch, once ----
check(await p.locator("#settings-map").isVisible(), "the map shows");
const leaves = await p.evaluate(() => Object.keys(self.XrnTube.DEFAULT_SETTINGS).sort());
const spots = await p.evaluate(() => [...document.querySelectorAll("[data-map]")].map((s) => s.dataset.map).sort());
const missing = leaves.filter((k) => !spots.includes(k));
const extra = spots.filter((k) => !leaves.includes(k));
if (missing.length || extra.length || spots.length !== leaves.length) {
  fail(`map and switches differ: missing ${missing}, unknown ${extra}, ${spots.length} spots for ${leaves.length} leaves`);
} else ok(`the map has one spot for each of the ${leaves.length} switches`);

// ---- 2. in step with the list, both ways ----
await spot("actionShare").click();
await p.waitForTimeout(150);
check((await stored("actionShare")) === false, "a click on the map changes the real setting");
check(!(await listBox("actionShare").isChecked()), "the list follows the map");
check((await spot("actionShare").getAttribute("aria-checked")) === "false", "the spot reports itself off");
check(await spot("actionShare").evaluate((s) => s.classList.contains("kept")), "a switched-off spot reads as kept");
check(
  await spot("actionShare").evaluate((s) => document.activeElement === s),
  "the spot keeps focus through its own toggle"
);
await p.locator('.switch[data-key="actionShare"]').click();
await p.waitForTimeout(150);
check(await spot("actionShare").evaluate((s) => s.classList.contains("gone")), "the map follows the list");
check((await stored("actionShare")) === true, "the list still writes the setting");
for (const key of ["pipButton", "commentsTwoColumn", "logoToSubscriptions"]) {
  const cls = await spot(key).getAttribute("class");
  check(cls.includes("changed") && !cls.includes("gone"), `${key} changes YouTube, so it isn't drawn as gone`);
}
check(await spot("blockInEmbeds").evaluate((s) => s.classList.contains("kept")), "the one off-by-default switch starts kept");

// ---- 3. a search makes room ----
await p.fill("#settings-search", "chapters");
await p.waitForTimeout(100);
check(!(await p.locator("#settings-map").isVisible()), "a search hides the map so its matches are on screen");
await p.fill("#settings-search", "");
await p.waitForTimeout(100);
check(await p.locator("#settings-map").isVisible(), "clearing the search brings the map back");
await p.fill("#settings-search", "pop-out"); // only in pipButton's description
await p.waitForTimeout(100);
check(await p.locator('.switch[data-key="pipButton"]').isVisible(), "a search still reads the descriptions the page doesn't show");
await p.fill("#settings-search", "");
await p.waitForTimeout(100);

// ---- 4. fewer words, but never the ones that protect you ----
await p.click('.page-tab[data-page="data"]');
check(await p.locator(".danger-card .blurb").isVisible(), "the Danger zone keeps its warning");
check(await p.locator("#danger-channels-desc").isVisible(), "each delete still says what it would remove");

// ---- 5. Sync, and a phone ----
await p.click('.page-tab[data-page="sync"]');
check(!(await p.locator("#sync-actions").isVisible()), "Sync's buttons stay hidden with nothing connected");
const fieldStyle = (sel) =>
  p.evaluate((s) => {
    const c = getComputedStyle(document.querySelector(s));
    return [c.backgroundColor, c.borderTopColor, c.borderRadius, c.fontFamily].join("|");
  }, sel);
check((await fieldStyle("#sync-url")) === (await fieldStyle("#sync-user")), "the address box matches the other fields");
await p.setViewportSize({ width: 412, height: 880 });
await p.click('.page-tab[data-page="blocklist"]');
await p.evaluate(() => {
  document.querySelector("#bulk-progress").hidden = false;
  document.querySelector("#bulk-progress-text").textContent = "Fetching sub counts and @handles… 0 / 240 · keeps going if you close this page";
});
await p.waitForTimeout(100);
const slide = () => p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
check((await slide()) <= 0, "a long progress line doesn't push the phone page sideways");
await p.evaluate(() => (document.querySelector("#bulk-progress").hidden = true));
await p.click('.page-tab[data-page="settings"]');
check((await slide()) <= 0, "the map fits a phone");
const strip = await p.evaluate(() => {
  const nav = document.querySelector(".sidenav");
  return { all: [...document.querySelectorAll(".page-tab")].every((t) => t.getBoundingClientRect().right <= window.innerWidth), overflow: nav.scrollWidth - nav.clientWidth };
});
check(strip.all && strip.overflow <= 0, "all six pages fit the phone's menu strip");
await p.setViewportSize({ width: 1400, height: 1000 });

// ---- 6. readable in both color schemes ----
const contrast = (scheme) =>
  p.evaluate(async () => {
    const lum = (hex) => {
      const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const css = getComputedStyle(document.documentElement);
    const v = (n) => css.getPropertyValue(n).trim();
    const ratio = (a, b) => {
      const [x, y] = [lum(v(a)), lum(v(b))].sort((m, n) => n - m);
      return (x + 0.05) / (y + 0.05);
    };
    return {
      grey: ratio("--ink-3", "--panel"),
      gone: ratio("--gone", "--hatch-a"),
      solid: ratio("--solid-ink", "--solid"),
      onDanger: ratio("--accent-ink", "--danger")
    };
  });
for (const scheme of ["light", "dark"]) {
  await p.emulateMedia({ colorScheme: scheme });
  const c = await contrast(scheme);
  check(Object.values(c).every((n) => n >= 4.5), `${scheme}: text passes 4.5:1 (${Object.values(c).map((n) => n.toFixed(2)).join(", ")})`);
}

// ---- 7. the popup's buttons stay readable under the cursor ----
// A hover that borrowed the border's colour made "Manage blocklist" navy on navy.
const popup = await ctx.newPage();
await popup.setViewportSize({ width: 320, height: 500 });
await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
for (const scheme of ["light", "dark"]) {
  await popup.emulateMedia({ colorScheme: scheme });
  await popup.hover("#manage-btn");
  await popup.waitForTimeout(100);
  const r = await popup.evaluate(() => {
    const lum = (css) => {
      const c = css.match(/\d+(\.\d+)?/g).slice(0, 3).map((n) => Number(n) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const st = getComputedStyle(document.querySelector("#manage-btn"));
    const [x, y] = [lum(st.color), lum(st.backgroundColor)].sort((m, n) => n - m);
    return (x + 0.05) / (y + 0.05);
  });
  check(r >= 4.5, `${scheme}: a hovered popup button stays readable (${r.toFixed(2)})`);
  await popup.mouse.move(0, 0);
}
await popup.close();

check(errs.length === 0, "no page errors" + (errs.length ? ": " + errs.join("; ") : ""));
await ctx.close();
console.log(process.exitCode ? "FAILED" : "DONE");
