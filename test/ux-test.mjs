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
const swErr = [];
sw.on("console", (m) => { if (m.type() === "error") swErr.push(m.text()); });

const opt = await ctx.newPage();
opt.on("dialog", (d) => d.accept());
opt.on("pageerror", (e) => fail("pageerror: " + e.message));
await opt.goto(`chrome-extension://${extId}/options/options.html`);
await opt.waitForLoadState("domcontentloaded");
await opt.waitForTimeout(300);
const send = (m) => opt.evaluate((mm) => chrome.runtime.sendMessage(mm), m);

// --- page tabs ---
const pages = await opt.locator(".page-tab").count();
pages === 4 ? ok("4 page tabs (Blocklist / Keywords / Settings / Sync)") : fail("page tabs: " + pages);
const blVisible = await opt.locator("#page-blocklist").isVisible();
const setHidden = await opt.locator("#page-settings").isHidden();
blVisible && setHidden ? ok("Blocklist page visible, Settings hidden by default") : fail(`bl=${blVisible} setHidden=${setHidden}`);

await opt.locator('.page-tab[data-page="settings"]').click();
await opt.waitForTimeout(150);
(await opt.locator("#page-settings").isVisible()) && (await opt.locator("#page-blocklist").isHidden())
  ? ok("clicking Settings tab swaps the visible page")
  : fail("settings tab did not swap");
(await opt.locator("#settings-list .switch").count()) === 12 ? ok("12 toggles present on Settings page") : fail("toggle count");

await opt.locator('.page-tab[data-page="sync"]').click();
await opt.waitForTimeout(150);
(await opt.locator("#page-sync").isVisible()) && (await opt.locator("#sync-card").isVisible())
  ? ok("Sync tab shows the gist card")
  : fail("sync tab");

// remembered across reload
await opt.reload();
await opt.waitForLoadState("domcontentloaded");
await opt.waitForTimeout(300);
(await opt.locator("#page-sync").isVisible())
  ? ok("last page remembered across reload (localStorage)")
  : fail("page not remembered");
await opt.locator('.page-tab[data-page="blocklist"]').click();
await opt.waitForTimeout(150);

// --- wider layout ---
const wrapW = await opt.evaluate(() => document.querySelector(".wrap").getBoundingClientRect().width);
wrapW > 900 ? ok(`content column widened to ${Math.round(wrapW)}px`) : fail(`still narrow: ${Math.round(wrapW)}px`);

// --- video-only channel row: whitelist panel collapsed by default ---
await send({ type: "BLOCK_CHANNEL", id: "@somesoftchan", name: "Soft", mode: "exceptWhitelist" });
await opt.waitForTimeout(200);
await opt.locator('.filter-tab[data-tab="videoOnly"]').click();
await opt.waitForTimeout(200);
const det = opt.locator("#channel-list details.whitelist-details").first();
(await det.count()) === 1 && !(await det.evaluate((d) => d.open))
  ? ok("video-only channel: whitelist/age panel is a collapsed <details>")
  : fail("whitelist panel not collapsed by default");
const summaryTxt = await det.locator("summary").textContent();
/Whitelist & age rule/.test(summaryTxt) ? ok(`summary: "${summaryTxt.trim()}"`) : fail("summary text: " + summaryTxt);
await send({ type: "UNBLOCK_CHANNEL", id: "@somesoftchan" });

// --- mass-delete blocked videos ---
for (const v of ["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc"]) await send({ type: "BLOCK_VIDEO", id: v, title: "v " + v });
await opt.waitForTimeout(200);
await opt.locator('.filter-tab[data-tab="videos"]').click();
await opt.waitForTimeout(200);
const clearBtn = opt.locator("#clear-videos-btn");
const clearTxt = await clearBtn.textContent();
(!(await clearBtn.isHidden()) && /Clear all 3 blocked videos/.test(clearTxt))
  ? ok(`clear button shown: "${clearTxt.trim()}"`)
  : fail(`clear button wrong: hidden=${await clearBtn.isHidden()} text="${clearTxt}"`);

await clearBtn.click(); // dialog auto-accepted
await opt.waitForTimeout(600);
const after = await send({ type: "GET_BLOCKLIST" });
Object.keys(after.videos).length === 0
  ? ok("mass-delete removed every blocked video")
  : fail(`${Object.keys(after.videos).length} videos left after clear`);

// tombstones written so the deletion propagates via gist
const tombs = await opt.evaluate(() => chrome.storage.local.get("bt_tombstones"));
const vidTombs = Object.keys(tombs.bt_tombstones || {}).filter((k) => k.startsWith("video:"));
vidTombs.length >= 3 ? ok(`${vidTombs.length} video tombstones written`) : fail("no video tombstones: " + JSON.stringify(tombs));

const rerender = await opt.locator("#clear-videos-btn").isHidden();
rerender ? ok("clear button hides once there are no videos") : fail("clear button still shown");

await opt.waitForTimeout(300);
swErr.length ? fail("SW errors:\n" + swErr.join("\n")) : ok("no service worker console errors");
await ctx.close();
console.log("\nDONE");
