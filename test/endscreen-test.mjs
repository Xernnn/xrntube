import { chromium } from "playwright";

const EXT_PATH = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const VIDEO = "https://www.youtube.com/watch?v=aqz-KE-bpKQ";
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

async function loadNearEnd(p) {
  await p.goto(VIDEO, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(5000);
  await p.evaluate(() => {
    const v = document.querySelector("video");
    const go = () => {
      if (v && v.duration && isFinite(v.duration)) {
        v.muted = true;
        v.currentTime = v.duration - 1.5;
        v.play().catch(() => {});
      } else setTimeout(go, 400);
    };
    go();
  });
  await p.waitForTimeout(9000);
}

function probe() {
  const grid = document.querySelector(".ytp-fullscreen-grid");
  const stills = document.querySelectorAll(".ytp-modern-videowall-still, .ytp-videowall-still");
  const style = document.getElementById("bt-instant-hide");
  return {
    gridExists: !!grid,
    gridDisplay: grid ? getComputedStyle(grid).display : null,
    stillCount: stills.length,
    styleCoversGrid: !!style && /ytp-fullscreen-grid/.test(style.textContent),
    styleCoversStill: !!style && /ytp-modern-videowall-still/.test(style.textContent),
  };
}

// --- default (removeEndScreen ON) ---
const p1 = await ctx.newPage();
await loadNearEnd(p1);
const on = await p1.evaluate(probe);
await p1.close();
console.log("   ON :", JSON.stringify(on));
on.styleCoversGrid && on.styleCoversStill
  ? ok("instant-hide CSS now covers .ytp-fullscreen-grid + .ytp-modern-videowall-still")
  : fail("CSS missing the new end-screen rules: " + JSON.stringify(on));
(!on.gridExists || on.gridDisplay === "none")
  ? ok(`end-screen grid neutralised (exists=${on.gridExists}, display=${on.gridDisplay})`)
  : fail(`grid still shown: display=${on.gridDisplay}`);
on.stillCount === 0
  ? ok("0 videowall still-tiles left in the DOM (scrub removed them)")
  : fail(`${on.stillCount} still-tiles survived`);

// --- toggle removeEndScreen OFF -> grid comes back ---
const opt = await ctx.newPage();
await opt.goto(`chrome-extension://${extId}/options/options.html`);
await opt.waitForLoadState("domcontentloaded");
await opt.waitForTimeout(300);
await opt.locator(".page-tab[data-page='settings']").click();
await opt.waitForTimeout(150);
// removeEndScreen is index 6
await opt.locator("#settings-list .switch .slider").nth(6).click();
await opt.waitForFunction(
  () => chrome.storage.sync.get("bt_settings").then((r) => r.bt_settings && r.bt_settings.removeEndScreen === false),
  null, { timeout: 3000 }
);

const p2 = await ctx.newPage();
await loadNearEnd(p2);
const off = await p2.evaluate(probe);
await p2.close();
console.log("   OFF:", JSON.stringify(off));
// The video never truly "ends" in headless, so .ytp-fullscreen-grid sits in
// YouTube's own pre-end display:none regardless. What we CAN prove is that our
// code stops touching it: the CSS rule is gone and the still-tiles are back in
// the DOM (the scrub removed them in the ON case).
!off.styleCoversGrid && !off.styleCoversStill && off.stillCount > 0
  ? ok(`toggle off: our CSS rule dropped, ${off.stillCount} still-tiles back in the DOM (scrub no longer removing them)`)
  : fail("toggle off did not release the end screen: " + JSON.stringify(off));

await ctx.close();
console.log("\nDONE");
