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

// --- 1. options: sort + hide-small (drive the page globals directly) ---
const p = await ctx.newPage();
p.on("pageerror", (e) => fail("options pageerror: " + e.message));
await p.goto(`chrome-extension://${extId}/options/options.html`);
await p.waitForLoadState("domcontentloaded");
await p.waitForTimeout(200);

const names = () =>
  p.$$eval("#channel-list .channel-row .item-name", (els) => els.map((e) => e.textContent));

await p.evaluate(() => {
  state = {
    channels: {
      c_big: { name: "Big", ts: 1, subs: "1.2M", subsAt: Date.now() },
      c_mid: { name: "Mid", ts: 2, subs: "50K", subsAt: Date.now() },
      c_small: { name: "Small", ts: 3, subs: "8K", subsAt: Date.now() },
      c_unk: { name: "Unknown", ts: 4 }
    },
    videos: {}
  };
  sortBy = "subsDesc";
  hideSmall = false;
  render();
});
let order = await names();
JSON.stringify(order) === JSON.stringify(["Big", "Mid", "Small", "Unknown"])
  ? ok("sort subsDesc: Big > Mid > Small > Unknown(last)")
  : fail("subsDesc order wrong: " + JSON.stringify(order));

await p.evaluate(() => { sortBy = "subsAsc"; render(); });
order = await names();
JSON.stringify(order) === JSON.stringify(["Small", "Mid", "Big", "Unknown"])
  ? ok("sort subsAsc: Small < Mid < Big < Unknown(last)")
  : fail("subsAsc order wrong: " + JSON.stringify(order));

await p.evaluate(() => { sortBy = "name"; render(); });
order = await names();
JSON.stringify(order) === JSON.stringify(["Big", "Mid", "Small", "Unknown"])
  ? ok("sort name A–Z")
  : fail("name order wrong: " + JSON.stringify(order));

await p.evaluate(() => { hideSmall = true; smallThreshold = 10000; render(); });
order = await names();
const smallNote = await p.textContent("#small-note");
!order.includes("Small") && order.includes("Unknown") && /1 channel/.test(smallNote || "")
  ? ok("hide-small: 8K channel hidden, unknown kept, note shows count")
  : fail(`hide-small wrong: order=${JSON.stringify(order)} note="${smallNote}"`);

await p.evaluate(() => { smallThreshold = 60000; render(); });
order = await names();
JSON.stringify(order.sort()) === JSON.stringify(["Big", "Unknown"])
  ? ok("hide-small threshold 60k: only Big + Unknown remain")
  : fail("threshold 60k wrong: " + JSON.stringify(order));

// fetch-all button shows a count of channels missing subs. It lives in the
// blocklist bar's ⋯ menu now — a sweep you run about once, not a control that
// earns permanent space — so the menu has to be opened to see it.
await p.evaluate(() => {
  const v = self.BlockTube.SUBS_SCRAPE_VERSION;
  state = {
    channels: {
      a: { name: "A", ts: 1 },
      b: { name: "B", ts: 2, subs: "1M", subsAt: Date.now(), subsV: v },
      c: { name: "C", ts: 3 }
    },
    videos: {}
  };
  hideSmall = false; sortBy = "recent"; bulkRunning = false; render();
});
await p.click("#bl-menu-btn");
await p.waitForTimeout(150);
const fa = await p.textContent("#fetch-all-subs-btn");
const faHidden = await p.locator("#fetch-all-subs-btn").isHidden();
!faHidden && /\b2\b/.test(fa)
  ? ok('fetch-all button: "' + fa.trim() + '"')
  : fail(`fetch-all button wrong: hidden=${faHidden} text="${fa}"`);
await p.keyboard.press("Escape");

// --- 2. masthead logo retargeted on a live YouTube page ---
const yt = await ctx.newPage();
await yt.goto("https://www.youtube.com/feed/subscriptions", { waitUntil: "domcontentloaded" });
await yt.waitForTimeout(5000);
const logoHref = await yt.evaluate(() => {
  const a = document.querySelector("ytd-masthead a#logo, #masthead a#logo, ytd-topbar-logo-renderer a");
  return a ? a.getAttribute("href") : "(no logo anchor found)";
});
console.log("   masthead logo href ->", logoHref);
logoHref === "https://www.youtube.com/feed/subscriptions"
  ? ok("masthead logo href retargeted to Subscriptions")
  : fail("logo href not retargeted: " + logoHref);

await ctx.close();
console.log("\nDONE");
